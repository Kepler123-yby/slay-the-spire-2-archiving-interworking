import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../src/service.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-refresh-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const counts = { mkdir: 0, list: 0, get: 0 };
  const quark = {
    async mkdir(name, parent = path.join(root, "cloud")) {
      counts.mkdir++;
      const dir = path.join(parent, name);
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
    async list(dir) {
      counts.list++;
      return Promise.all(
        (await fs.readdir(dir)).map(async (filename) => {
          const fid = path.join(dir, filename),
            st = await fs.stat(fid);
          return { filename, fid, size: st.size, modified: st.mtimeMs };
        }),
      );
    },
    async get(fid) {
      counts.get++;
      return fid;
    },
    async put(file, parent) {
      await fs.copyFile(file, path.join(parent, path.basename(file)));
    },
  };
  const p = {
    account: "76561198000000000",
    profile: "profile1",
    group: "modded",
    dir: path.join(root, "saves"),
  };
  await fs.mkdir(p.dir);
  await fs.writeFile(path.join(p.dir, "progress.save"), "original");
  const service = new Service({
    quark,
    stateDir: path.join(root, "state"),
    checkGame: async () => {},
    getEnvironment: async () => null,
  });
  await service.upload(p);
  return { service, quark, counts, p, root };
}

test("重复刷新只列举一次目录，新增版本只下载新摘要，删除版本不会继续显示", async (t) => {
  const { service, counts, p } = await fixture(t);
  const first = await service.versions(p);
  Object.keys(counts).forEach((k) => (counts[k] = 0));
  assert.deepEqual(await service.versions(p), first);
  assert.deepEqual(counts, { mkdir: 0, list: 1, get: 0 });
  await service.upload(p);
  Object.keys(counts).forEach((k) => (counts[k] = 0));
  const second = await service.versions(p);
  assert.equal(second.length, 2);
  assert.deepEqual(counts, { mkdir: 0, list: 1, get: 1 });
  await fs.unlink(
    path.join(await service.folder(p), first[0].id + ".ready.json"),
  );
  assert.equal((await service.versions(p)).length, 1);
});

test("摘要变化和强制刷新会重新读取，应用前不信任旧缓存", async (t) => {
  const { service, counts, p } = await fixture(t);
  const [v] = await service.versions(p);
  counts.get = 0;
  await service.versions(p, { fresh: true });
  assert.equal(counts.get, 1);
  const marker = path.join(await service.folder(p), v.id + ".ready.json");
  await fs.writeFile(marker, "{}");
  assert.deepEqual(await service.versions(p), []);
  // Even a cache entry from a previous listing cannot authorize application.
  await assert.rejects(service.download(p, v.id, true), /未找到/);
  assert.equal(
    await fs.readFile(path.join(p.dir, "progress.save"), "utf8"),
    "original",
  );
});

test("执行器切换及云端错误清空缓存，同步组之间不混用目录", async (t) => {
  const { service, quark, counts, p } = await fixture(t);
  await service.versions(p);
  quark.executor = () => {};
  counts.mkdir = 0;
  await service.versions(p);
  assert.equal(counts.mkdir, 4);
  assert.deepEqual(await service.versions({ ...p, group: "vanilla" }), []);
  const list = quark.list;
  quark.list = async () => {
    throw Error("remote failed");
  };
  await assert.rejects(service.versions(p), /remote failed/);
  quark.list = list;
  counts.mkdir = 0;
  await service.versions(p);
  assert.equal(counts.mkdir, 4);
});

test("缓存60秒后重新下载；应用前即使目录属性不变也回读完成标记", async (t) => {
  const { service, quark, counts, p } = await fixture(t);
  const [v] = await service.versions(p);
  for (const entry of service.markers.values()) entry.expires = 0;
  counts.get = 0;
  await service.versions(p);
  assert.equal(counts.get, 1);
  const listing = await quark.list(await service.folder(p));
  quark.list = async () => listing;
  const file = path.join(await service.folder(p), v.id + ".ready.json");
  const marker = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ ...marker, hash: "0".repeat(64) }));
  await assert.rejects(service.download(p, v.id, true), /哈希/);
});

test("跨Agent传输的缓存有大小上限，过期项不传输", async (t) => {
  const { service } = await fixture(t);
  for (let i = 0; i < 35; i++)
    service.markers.set(String(i), {
      expires: Date.now() + 60000,
      meta: { summary: "x".repeat(120000) },
    });
  service.markers.set("expired", { expires: 0 });
  const cache = service.exportCloudCache();
  assert(Buffer.byteLength(JSON.stringify(cache)) <= 256 * 1024);
  assert(!cache.markers.some(([key]) => key === "expired"));
});

test("夸克每次枚举返回不同临时fid时仍复用同一未变摘要", async (t) => {
  const { service, quark, counts, p } = await fixture(t);
  const list = quark.list,
    get = quark.get;
  let generation = 0;
  quark.list = async (dir) =>
    (await list(dir)).map((item) => ({
      ...item,
      fid: item.fid + "#" + ++generation,
    }));
  quark.get = (fid) => get(fid.split("#")[0]);
  await service.versions(p);
  counts.get = 0;
  const [version] = await service.versions(p);
  assert.equal(counts.get, 0);
  assert(version.fid.endsWith("#4"));
});
