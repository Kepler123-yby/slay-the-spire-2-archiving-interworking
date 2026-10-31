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
  }) {
    Object.assign(this, { quark, stateDir, checkGame, getEnvironment });
    this.busy = false;
  }
  async exclusive(fn) {
    if (this.busy) throw Error("已有任务运行，请等待完成");
    this.busy = true;
    try {
      return await fn();
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
    let fid = await this.quark.mkdir("STS2-SaveSync");
    for (const part of [p.account, p.profile, p.group])
      fid = await this.quark.mkdir(part, fid);
    return fid;
  }
  async versions(p) {
    const fid = await this.folder(p),
      items = await this.quark.list(fid),
      versions = [];
    for (const item of items.filter((x) =>
      /^[a-f0-9-]{36}\.ready\.json$/.test(x.filename),
    )) {
      if (item.size > 128 * 1024) throw Error("云端完成标记过大");
      const file = await this.quark.get(item.fid);
      if ((await fs.stat(file)).size > 128 * 1024) throw Error("完成标记超限");
      let m;
      try {
        m = JSON.parse(await fs.readFile(file, "utf8"));
      } catch {
        continue;
      }
      if (
        m.format !== 1 ||
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
      const payload = items.find((x) => x.filename === m.id + ".snapshot.json");
      if (!payload || payload.size > LIMIT * 1.5) continue;
      versions.push({ ...m, fid: payload.fid });
    }
    return versions.sort((a, b) =>
      String(b.createdAt).localeCompare(String(a.createdAt)),
    );
  }
  async backup(p) {
    return this.exclusive(async () => {
      await this.checkGame();
      await recover(p.dir);
      const s = await capture(
        p.dir,
        this.identity(p),
        [],
        await this.getEnvironment(),
      );
      await atomicJSON(path.join(this.scope(p), "backups", s.id + ".json"), s);
      return "本地备份已保存，仅保存在本机；备份 ID：" + s.id;
    });
  }
  async backups(p) {
    const dir = path.join(this.scope(p), "backups");
    return (await fs.readdir(dir).catch(() => []))
      .filter((x) => /^[a-f0-9-]{36}\.json$/.test(x))
      .map((x) => x.slice(0, -5));
  }
  async upload(p) {
    return this.exclusive(async () => {
      await this.checkGame();
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
      const fid = await this.folder(p);
      await this.quark.put(file, fid);
      const items = await this.quark.list(fid);
      const remote = items.find((x) => x.filename === path.basename(file));
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
      const published = await this.quark.list(fid);
      const r = published.find((x) => x.filename === path.basename(ready));
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
    });
  }
  async download(p, id, confirm) {
    return this.exclusive(async () => {
      if (confirm !== true)
        throw Error(
          "应用存档需要确认 Steam 云已关闭、两端游戏版本及 Mod 环境一致",
        );
      await this.checkGame();
      await recover(p.dir);
      const before = contentHash(await readFiles(p.dir));
      const versions = await this.versions(p),
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
      if (!confirm || !/^[a-f0-9-]{36}$/.test(id))
        throw Error("请选择备份并确认恢复");
      await this.checkGame();
      await recover(p.dir);
      const s = await load(path.join(this.scope(p), "backups", id + ".json"));
      if (
        s.account !== p.account ||
        s.profile !== p.profile ||
        s.group !== p.group
      )
        throw Error("备份身份不匹配");
      await apply(p.dir, s, this.scope(p), {
        checkpoint: async () => this.checkGame(),
      });
      await fs.rm(path.join(this.scope(p), "baseline.json"), { force: true });
      return "本地备份已恢复；下次上传会保留为独立分支";
    });
  }
}
