import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service, heads, conflict } from "../src/service.mjs";
class FakeCloud {
  constructor(root) {
    this.root = root;
  }
  async mkdir(name, parent = this.root) {
    const d = path.join(parent, name);
    await fs.mkdir(d, { recursive: true });
    return d;
  }
  async put(file, parent) {
    await fs.copyFile(file, path.join(parent, path.basename(file)));
  }
  async list(fid) {
    return Promise.all(
      (await fs.readdir(fid)).map(async (filename) => ({
        filename,
        fid: path.join(fid, filename),
        size: (await fs.stat(path.join(fid, filename))).size,
      })),
    );
  }
  async get(fid) {
    return fid;
  }
}
test("两个离线分支必须显示冲突", () => {
  const v = [
    { id: "a", parents: [] },
    { id: "b", parents: ["a"] },
    { id: "c", parents: ["a"] },
  ];
  assert.equal(heads(v).length, 2);
  assert.equal(conflict("x", { hash: "x" }, v), true);
  assert.equal(conflict("x", null, v), true);
});
test("云端端到端模拟：上传、回读、应用、备份恢复，半成品不出现", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-service-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = {
    account: "76561198000000000",
    profile: "profile1",
    group: "vanilla",
    dir: path.join(root, "saves"),
  };
  await fs.mkdir(p.dir);
  await fs.writeFile(path.join(p.dir, "progress.save"), "first");
  const s = new Service({
    quark: new FakeCloud(path.join(root, "cloud")),
    stateDir: path.join(root, "state"),
    allowInitialUpload: true,
    checkGame: async () => {},
  });
  await s.upload(p);
  const v = await s.versions(p);
  assert.equal(v.length, 1);
  await fs.writeFile(path.join(p.dir, "progress.save"), "later");
  await assert.rejects(s.download(p, v[0].id, false), /确认/);
  await s.download(p, v[0].id, true);
  assert.equal(
    await fs.readFile(path.join(p.dir, "progress.save"), "utf8"),
    "first",
  );
  const b = await s.backups(p);
  assert.equal(b.length, 1);
  await s.restore(p, b[0], true);
  assert.equal(
    await fs.readFile(path.join(p.dir, "progress.save"), "utf8"),
    "later",
  );
});
test("游戏运行时禁止备份和传输", async () => {
  const s = new Service({
    checkGame: async () => {
      throw Error("游戏仍运行");
    },
  });
  await assert.rejects(s.backup({}), /游戏仍运行/);
  await assert.rejects(s.upload({}), /游戏仍运行/);
});
test("Mac首次上传锁定且未调用云端", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-first-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "saves");
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "progress.save"), "old");
  let called = false;
  const service = new Service({
    quark: {
      mkdir: () => {
        called = true;
      },
    },
    stateDir: path.join(root, "state"),
    allowInitialUpload: false,
    checkGame: async () => {},
  });
  await assert.rejects(
    service.upload({
      account: "76561198000000000",
      profile: "profile1",
      group: "modded",
      dir,
    }),
    /首次接入/,
  );
  assert.equal(called, false);
});
test("原版与Mod云端目录和备份空间隔离", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-group-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const s = new Service({
    quark: new FakeCloud(path.join(root, "cloud")),
    stateDir: root,
  });
  const p = {
    account: "76561198000000000",
    profile: "profile1",
    group: "vanilla",
  };
  assert.notEqual(await s.folder(p), await s.folder({ ...p, group: "modded" }));
  assert.notEqual(s.scope(p), s.scope({ ...p, group: "modded" }));
});
