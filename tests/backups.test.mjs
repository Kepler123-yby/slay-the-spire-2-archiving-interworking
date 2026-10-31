import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Backups } from "../src/backups.mjs";
import { capture, atomicJSON } from "../src/snapshot.mjs";
import { Service } from "../src/service.mjs";
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-cap-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "saves");
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "progress.save"), "original");
  const store = new Backups({ root: path.join(root, "backups") });
  const identity = {
    account: "76561198000000000",
    profile: "profile1",
    group: "vanilla",
  };
  return { root, dir, store, identity };
}
test("本机2份是跨账号档位同步组总额，第三份必须先删除", async (t) => {
  const f = await fixture(t);
  await f.store.save(await capture(f.dir, f.identity));
  await f.store.save(
    await capture(f.dir, {
      ...f.identity,
      profile: "profile2",
      group: "modded",
    }),
  );
  await assert.rejects(f.store.save(await capture(f.dir, f.identity)), /2 份/);
  const items = await f.store.list();
  await f.store.remove(items[0].key);
  await f.store.save(await capture(f.dir, f.identity));
  assert.equal((await f.store.list()).length, 2);
});
test("备份满额时恢复和云端覆盖均在写入之前停止", async (t) => {
  const f = await fixture(t);
  await f.store.save(await capture(f.dir, f.identity));
  await f.store.save(await capture(f.dir, f.identity));
  const service = new Service({
    stateDir: f.root,
    backupStore: f.store,
    checkGame: async () => {},
    getEnvironment: async () => null,
  });
  const p = { ...f.identity, dir: f.dir };
  await assert.rejects(service.download(p, "anything", true), /2 份/);
  await assert.rejects(
    service.restore(p, (await f.store.list())[0].key, true),
    /2 份/,
  );
  assert.equal(
    await fs.readFile(path.join(f.dir, "progress.save"), "utf8"),
    "original",
  );
});
test("旧版备份计入限额，可通过工具删除，未知键不删除任何文件", async (t) => {
  const f = await fixture(t);
  const legacy = path.join(f.root, "legacy");
  const s = await capture(f.dir, f.identity);
  await atomicJSON(
    path.join(legacy, s.account, s.profile, s.group, "backups", s.id + ".json"),
    s,
  );
  const store = new Backups({ root: f.store.root, legacyRoots: [legacy] });
  await store.save(await capture(f.dir, f.identity));
  assert.equal((await store.list()).length, 2);
  await assert.rejects(store.remove("../progress.save"), /未找到/);
  await store.remove((await store.list()).find((x) => x.id === s.id).key);
  assert.equal((await store.list()).length, 1);
});
test("两个实例共用一个备份目录，顺序化并发保存不超过2份", async (t) => {
  const f = await fixture(t);
  const other = new Backups({ root: f.store.root });
  const snapshots = await Promise.all(
    [1, 2, 3].map(() => capture(f.dir, f.identity)),
  );
  const result = await Promise.allSettled(
    snapshots.map((s, i) => (i % 2 ? other : f.store).save(s)),
  );
  assert.equal(result.filter((x) => x.status === "fulfilled").length, 2);
  assert.equal((await f.store.list()).length, 2);
});
test("损坏的旧备份仍计数并可在工具中删除", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.store.root, { recursive: true });
  await fs.writeFile(
    path.join(f.store.root, "11111111-1111-4111-8111-111111111111.json"),
    "bad json",
  );
  const [b] = await f.store.list();
  assert.equal(b.corrupt, true);
  await f.store.remove(b.key);
  assert.equal((await f.store.list()).length, 0);
});
test("删除需要明确确认，删除后不修改当前游戏存档", async (t) => {
  const f = await fixture(t);
  await f.store.save(await capture(f.dir, f.identity));
  const [item] = await f.store.list();
  const service = new Service({ stateDir: f.root, backupStore: f.store });
  await assert.rejects(service.deleteBackup(item.key, false), /确认/);
  assert.equal((await f.store.list()).length, 1);
  await service.deleteBackup(item.key, true);
  assert.equal((await f.store.list()).length, 0);
  assert.equal(
    await fs.readFile(path.join(f.dir, "progress.save"), "utf8"),
    "original",
  );
});
