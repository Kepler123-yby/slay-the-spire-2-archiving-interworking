import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { load, validate, atomicJSON } from "./snapshot.mjs";
export const LOCAL_BACKUP_LIMIT = 2;
const UUID = /^[a-f0-9-]{36}$/;
const queues = new Map();
async function entries(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
async function directory(dir) {
  try {
    const s = await fs.lstat(dir);
    if (!s.isDirectory() || s.isSymbolicLink()) throw Error("备份目录类型无效");
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
export class Backups {
  constructor({ root, legacyRoots = [] }) {
    this.root = path.resolve(root);
    this.legacyRoots = [...new Set(legacyRoots.map((p) => path.resolve(p)))];
  }
  async locked(fn) {
    const before = queues.get(this.root) || Promise.resolve();
    const task = before.catch(() => {}).then(fn);
    queues.set(this.root, task);
    try {
      return await task;
    } finally {
      if (queues.get(this.root) === task) queues.delete(this.root);
    }
  }
  async files() {
    const files = new Set();
    const add = async (dir) => {
      if (!(await directory(dir))) return;
      for (const e of await entries(dir))
        if (
          e.isFile() &&
          UUID.test(e.name.slice(0, -5)) &&
          e.name.endsWith(".json")
        )
          files.add(path.join(dir, e.name));
    };
    await add(this.root);
    for (const root of this.legacyRoots) {
      if (!(await directory(root))) continue;
      for (const a of await entries(root)) {
        if (!a.isDirectory() || !/^\d{5,20}$/.test(a.name)) continue;
        for (const profile of ["profile1", "profile2", "profile3"])
          for (const group of ["vanilla", "modded"]) {
            const base = path.join(root, a.name, profile, group);
            if (!(await directory(path.join(root, a.name)))) continue;
            if (!(await directory(path.join(root, a.name, profile)))) continue;
            if (!(await directory(base))) continue;
            await add(path.join(base, "backups"));
          }
      }
    }
    return [...files].map((file) => ({
      file,
      key: createHash("sha256").update(file).digest("hex"),
      id: path.basename(file, ".json"),
    }));
  }
  async assertCapacity() {
    if ((await this.files()).length >= LOCAL_BACKUP_LIMIT)
      throw Error(
        "本机已达到 2 份本地备份上限，请在工具中删除至少 1 份后再备份或覆盖存档",
      );
  }
  async save(snapshot) {
    return this.locked(async () => {
      validate(snapshot);
      await this.assertCapacity();
      if ((await this.files()).some((item) => item.id === snapshot.id))
        throw Error("备份 ID 已存在，不会覆盖已有备份");
      await fs.mkdir(this.root, { recursive: true });
      await directory(this.root);
      await atomicJSON(path.join(this.root, snapshot.id + ".json"), snapshot);
      return snapshot.id;
    });
  }
  async list() {
    const out = [];
    for (const item of await this.files()) {
      try {
        const s = await load(item.file);
        out.push({
          key: item.key,
          id: s.id,
          account: s.account,
          profile: s.profile,
          group: s.group,
          createdAt: s.createdAt,
          summary: s.summary,
          corrupt: false,
        });
      } catch {
        out.push({
          key: item.key,
          id: item.id,
          account: null,
          profile: null,
          group: null,
          createdAt: null,
          summary: null,
          corrupt: true,
        });
      }
    }
    return out.sort((a, b) =>
      String(b.createdAt).localeCompare(String(a.createdAt)),
    );
  }
  async find(key) {
    const matches = (await this.files()).filter(
      (x) => x.key === key || x.id === key,
    );
    if (matches.length !== 1)
      throw Error("未找到唯一的本地备份，请刷新列表后重试");
    return matches[0];
  }
  async read(key) {
    return load((await this.find(key)).file);
  }
  async remove(key) {
    return this.locked(async () => {
      const item = await this.find(key);
      const stat = await fs.lstat(item.file);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw Error("备份文件类型无效");
      await fs.unlink(item.file);
      return item.id;
    });
  }
}
