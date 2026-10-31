import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  capture,
  load,
  validate,
  apply,
  recover,
  atomicJSON,
  readFiles,
  contentHash,
  digest,
  LIMIT,
} from "./snapshot.mjs";
import { Backups, LOCAL_BACKUP_LIMIT } from "./backups.mjs";
import { readEnvironment } from "./environment.mjs";
import { assertGameClosed } from "./platform.mjs";
export function heads(versions) {
  const parents = new Set(versions.flatMap((v) => v.parents));
  return versions.filter((v) => !parents.has(v.id));
}
export function conflict(local, base, versions) {
  return (
    versions.length > 0 &&
    (!base || local !== base.hash || heads(versions).length > 1)
  );
}
export class Service {
  constructor({
    quark,
    stateDir,
    checkGame = assertGameClosed,
    getEnvironment = readEnvironment,
    backupStore,
    cache,
  }) {
    Object.assign(this, { quark, stateDir, checkGame, getEnvironment });
    this.backupStore =
      backupStore ||
      new Backups({
        root: path.join(stateDir || ".data", "local-backups"),
        legacyRoots: stateDir ? [stateDir] : [],
      });
    this.busy = false;
    this.clearCloudCache();
    if (cache) this.importCloudCache(cache);
  }
  clearCloudCache() {
    this.folders = new Map();
    this.markers = new Map();
    this.cacheExecutor = this.quark?.executor;
    this.cacheSaveExecutor = this.quark?.saveExecutor;
  }
  syncCloudCache() {
    if (
      this.cacheExecutor !== this.quark?.executor ||
      this.cacheSaveExecutor !== this.quark?.saveExecutor
    )
      this.clearCloudCache();
  }
  exportCloudCache() {
    const cache = { folders: [], markers: [] };
    let bytes = Buffer.byteLength(JSON.stringify(cache));
    for (const [kind, entries] of [
      ["folders", [...this.folders]],
      ["markers", [...this.markers].reverse()],
    ]) {
      for (const entry of entries) {
        if (kind === "markers" && entry[1].expires <= Date.now()) continue;
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (bytes + size > 256 * 1024) continue;
        cache[kind].push(entry);
        bytes += size;
      }
    }
    return cache;
  }
  importCloudCache(cache) {
    this.folders = new Map(cache.folders);
    this.markers = new Map(cache.markers);
  }
  async remoteSave(operation, p, options = {}) {
    const result = await this.quark.saveExecutor({
      operation,
      profile: { account: p.account, profile: p.profile, group: p.group },
      stateDir: this.stateDir,
      cache: this.exportCloudCache(),
      ...options,
    });
    this.importCloudCache(result.cache);
    return result.value;
  }
  async exclusive(fn) {
    if (this.busy) throw Error("已有任务运行，请等待完成");
    this.busy = true;
    try {
      return await fn();
    } catch (error) {
      this.clearCloudCache();
      throw error;
    } finally {
      this.busy = false;
    }
  }
  identity(p) {
    if (
      !/^\d{5,20}$/.test(p.account) ||
      !/^profile[123]$/.test(p.profile) ||
      !["vanilla", "modded"].includes(p.group)
    )
      throw Error("存档身份无效");
    return {
      account: p.account,
      profile: p.profile,
      group: p.group,
      device: os.hostname(),
    };
  }
  scope(p) {
    this.identity(p);
    return path.join(this.stateDir, p.account, p.profile, p.group);
  }
  async base(p) {
    return JSON.parse(
      await fs
        .readFile(path.join(this.scope(p), "baseline.json"), "utf8")
        .catch(() => "null"),
    );
  }
  async folder(p) {
    this.identity(p);
    this.syncCloudCache();
    let fid,
      key = "";
    for (const part of ["STS2-SaveSync", p.account, p.profile, p.group]) {
      key += "/" + part;
      if (!this.folders.has(key))
        this.folders.set(key, await this.quark.mkdir(part, fid));
      fid = this.folders.get(key);
    }
    return fid;
  }
  async versions(p, { fresh = false } = {}) {
    this.identity(p);
    this.syncCloudCache();
    try {
      return this.quark.saveExecutor
        ? await this.remoteSave("versions", p, { fresh })
        : await this.readVersions(p, fresh);
    } catch (error) {
      this.clearCloudCache();
      throw error;
    }
  }
  async readVersions(p, fresh) {
    const fid = await this.folder(p),
      items = await this.quark.list(fid),
      versions = [];
    const seen = new Set();
    for (const item of items.filter((x) =>
      /^[a-f0-9-]{36}\.ready\.json$/.test(x.filename),
    )) {
      if (item.size > 128 * 1024) throw Error("云端完成标记过大");
      const key = JSON.stringify([fid, item.filename]);
      seen.add(key);
      // Quark fids are temporary handles and may change on every listing.
      const signature = JSON.stringify([
          item.filename,
          item.size,
          item.created_at,
          item.updated_at,
          item.modified,
          item.mtime,
          item.etag,
          item.md5,
        ]),
        cached = this.markers.get(key);
      let m =
        !fresh && cached?.signature === signature && cached.expires > Date.now()
          ? cached.meta
          : null;
      if (!m) {
        this.markers.delete(key);
        const file = await this.quark.get(item.fid);
        if ((await fs.stat(file)).size > 128 * 1024)
          throw Error("完成标记超限");
        try {
          m = JSON.parse(await fs.readFile(file, "utf8"));
        } catch {
          continue;
        }
        if (
          m?.format !== 1 ||
          m.id + ".ready.json" !== item.filename ||
          m.account !== p.account ||
          m.profile !== p.profile ||
          m.group !== p.group ||
          !Array.isArray(m.parents) ||
          m.parents.length > 100 ||
          m.parents.some((x) => !/^[a-f0-9-]{36}$/.test(x)) ||
          !/^[a-f0-9]{64}$/.test(m.hash) ||
          !/^[a-f0-9]{64}$/.test(m.contentHash)
        )
          continue;
        this.markers.set(key, {
          folder: fid,
          signature,
          expires: Date.now() + 60000,
          meta: m,
        });
      }
      const payload = items.find((x) => x.filename === m.id + ".snapshot.json");
      if (!payload || payload.size > LIMIT * 1.5) continue;
      versions.push({ ...m, fid: payload.fid });
    }
    for (const [key, entry] of this.markers)
      if (entry.folder === fid && !seen.has(key)) this.markers.delete(key);
    return versions.sort((a, b) =>
      String(b.createdAt).localeCompare(String(a.createdAt)),
    );
  }
  async backup(p) {
    return this.exclusive(async () => {
      await this.checkGame();
      await recover(p.dir);
      await this.backupStore.assertCapacity();
      const s = await capture(
        p.dir,
        this.identity(p),
        [],
        await this.getEnvironment(),
      );
      await this.backupStore.save(s);
      return "本地备份已保存，仅保存在本机；备份 ID：" + s.id;
    });
  }
  async backups(p) {
    return (await this.backupStore.list())
      .filter(
        (b) =>
          !b.corrupt &&
          b.account === p.account &&
          b.profile === p.profile &&
          b.group === p.group,
      )
      .map((b) => b.id);
  }
  async backupInfo() {
    return { limit: LOCAL_BACKUP_LIMIT, items: await this.backupStore.list() };
  }
  async deleteBackup(key, confirmed) {
    return this.exclusive(async () => {
      if (confirmed !== true) throw Error("删除备份需要确认");
      const id = await this.backupStore.remove(key);
      return "已删除本机备份：" + id;
    });
  }
  async upload(p) {
    return this.exclusive(async () => {
      await this.checkGame();
      this.identity(p);
      this.syncCloudCache();
      await recover(p.dir);
      const base = await this.base(p);
      const s = await capture(
        p.dir,
        this.identity(p),
        base ? [...new Set([base.id, ...(base.resolved || [])])] : [],
        await this.getEnvironment(),
      );
      const root = this.scope(p),
        file = path.join(root, "outgoing", s.id + ".snapshot.json");
      await atomicJSON(file, s);
      if (this.quark.saveExecutor)
        return this.remoteSave("upload", p, { file });
      return this.publish(p, file, s);
    });
  }
  async waitForUploaded(parent, filename) {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 1000));
      const item = (await this.quark.list(parent)).find(
        (x) => x.filename === filename,
      );
      if (item) return item;
    }
    return null;
  }
  async publish(p, file, s) {
    this.identity(p);
    validate(s);
    if (
      s.account !== p.account ||
      s.profile !== p.profile ||
      s.group !== p.group ||
      file !== path.join(this.scope(p), "outgoing", s.id + ".snapshot.json")
    )
      throw Error("上传快照身份或目录不匹配");
    const root = this.scope(p);
    const fid = await this.folder(p);
    await this.quark.put(file, fid);
    const remote = await this.waitForUploaded(fid, path.basename(file));
    if (!remote) throw Error("云端尚未找到上传版本");
    const downloaded = await this.quark.get(remote.fid);
    const bytes = await fs.readFile(downloaded);
    if (digest(bytes) !== digest(await fs.readFile(file)))
      throw Error("上传回读校验失败，未发布版本");
    validate(JSON.parse(bytes));
    const { files, ...meta } = s,
      marker = { ...meta, hash: digest(bytes) };
    const ready = path.join(root, "outgoing", s.id + ".ready.json");
    await atomicJSON(ready, marker);
    await this.quark.put(ready, fid);
    const r = await this.waitForUploaded(fid, path.basename(ready));
    if (
      !r ||
      digest(await fs.readFile(await this.quark.get(r.fid))) !==
        digest(await fs.readFile(ready))
    )
      throw Error("云端完成标记尚未验证，请刷新版本列表");
    await atomicJSON(path.join(root, "baseline.json"), {
      id: s.id,
      hash: s.contentHash,
    });
    return "上传完成，云端回读校验通过";
  }
  async download(p, id, confirm) {
    return this.exclusive(async () => {
      if (confirm !== true)
        throw Error(
          "应用存档需要确认 Steam 云已关闭、两端游戏版本及 Mod 环境一致",
        );
      await this.checkGame();
      await recover(p.dir);
      await this.backupStore.assertCapacity();
      const before = contentHash(await readFiles(p.dir));
      const versions = await this.versions(p, { fresh: true }),
        v = versions.find((x) => x.id === id);
      if (!v) throw Error("未找到可应用版本");
      const file = await this.quark.get(v.fid);
      if ((await fs.stat(file)).size > LIMIT * 1.5) throw Error("下载快照过大");
      if (digest(await fs.readFile(file)) !== v.hash)
        throw Error("云端快照哈希不匹配");
      const s = await load(file);
      if (
        s.account !== p.account ||
        s.profile !== p.profile ||
        s.group !== p.group ||
        s.id !== v.id ||
        s.contentHash !== v.contentHash ||
        JSON.stringify(s.parents) !== JSON.stringify(v.parents)
      )
        throw Error("云端存档身份不匹配");
      await this.checkGame();
      if (contentHash(await readFiles(p.dir)) !== before)
        throw Error("下载期间本机进度变化，请重新操作");
      const backup = await apply(p.dir, s, this.scope(p), {
        saveBackup: (snapshot) => this.backupStore.save(snapshot),
        checkpoint: async () => {
          await this.checkGame();
        },
      });
      await atomicJSON(path.join(this.scope(p), "baseline.json"), {
        id: s.id,
        hash: s.contentHash,
        resolved: heads(versions).map((x) => x.id),
      });
      return "已下载并覆盖当前存档；覆盖前的本地备份 ID：" + backup;
    });
  }
  async restore(p, id, confirm) {
    return this.exclusive(async () => {
      if (
        !confirm ||
        typeof id !== "string" ||
        !/^(?:[a-f0-9-]{36}|[a-f0-9]{64})$/.test(id)
      )
        throw Error("请选择备份并确认恢复");
      await this.checkGame();
      await recover(p.dir);
      await this.backupStore.assertCapacity();
      const s = await this.backupStore.read(id);
      if (
        s.account !== p.account ||
        s.profile !== p.profile ||
        s.group !== p.group
      )
        throw Error("备份身份不匹配");
      await apply(p.dir, s, this.scope(p), {
        saveBackup: (snapshot) => this.backupStore.save(snapshot),
        checkpoint: async () => this.checkGame(),
      });
      await fs.rm(path.join(this.scope(p), "baseline.json"), { force: true });
      return "本地备份已恢复；下次上传会保留为独立分支";
    });
  }
}
