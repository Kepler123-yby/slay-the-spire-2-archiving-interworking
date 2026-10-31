import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service, heads, conflict } from "../src/service.mjs";
import { Quark } from "../src/quark.mjs";
import { validateQuarkTask } from "../src/agent-worker.mjs";
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

test("签名下载句柄经过worker校验后可覆盖合成存档，并保留覆盖前备份", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "spire-signed-download-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = {
    account: "76561198000000000",
    profile: "profile1",
    group: "modded",
    dir: path.join(root, "saves"),
  };
  await fs.mkdir(p.dir);
  await fs.writeFile(path.join(p.dir, "progress.save"), "remote fixture");
  await fs.writeFile(path.join(p.dir, "prefs.save"), "local preferences");
  const backend = new FakeCloud(path.join(root, "cloud"));
  const handles = new Map();
  const list = backend.list.bind(backend);
  backend.list = async (dir) =>
    (await list(dir)).map((item) => {
      const fid = "signed-fixture|" + Buffer.from(item.fid).toString("base64");
      handles.set(fid, item.fid);
      return { ...item, fid };
    });
  const workDir = path.join(root, "quark");
  const downloads = new Quark({
    workDir,
    executor: async (args) => {
      validateQuarkTask({ root: workDir, args });
      assert.equal(args[0], "download");
      assert.ok(args[2].includes("|"));
      const source = handles.get(args[2]);
      assert.ok(source);
      await fs.copyFile(source, path.join(args[4], path.basename(source)));
      return [{ type: "result", code: 0, data: {} }];
    },
  });
  backend.get = (fid) => downloads.get(fid);
  const service = new Service({
    quark: backend,
    stateDir: path.join(root, "state"),
    checkGame: async () => {},
  });
  await service.upload(p);
  const [version] = await service.versions(p);
  await fs.writeFile(path.join(p.dir, "progress.save"), "before overwrite");
  await service.download(p, version.id, true);
  assert.equal(
    await fs.readFile(path.join(p.dir, "progress.save"), "utf8"),
    "remote fixture",
  );
  assert.equal(
    await fs.readFile(path.join(p.dir, "prefs.save"), "utf8"),
    "local preferences",
  );
  const backups = await service.backups(p);
  assert.equal(backups.length, 1);
  await service.restore(p, backups[0], true);
  assert.equal(
    await fs.readFile(path.join(p.dir, "progress.save"), "utf8"),
    "before overwrite",
  );
});

test("上传快照和完成标记延迟可见时等待发布，不重复上传", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-publish-lag-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = {
    account: "76561198000000000",
    profile: "profile1",
    group: "modded",
    dir: path.join(root, "saves"),
  };
  await fs.mkdir(p.dir);
  await fs.writeFile(path.join(p.dir, "progress.save"), "fixture");
  const cloud = new FakeCloud(path.join(root, "cloud"));
  const put = cloud.put.bind(cloud),
    list = cloud.list.bind(cloud);
  let hidden = null,
    uploads = 0;
  cloud.put = async (file, parent) => {
    await put(file, parent);
    hidden = path.basename(file);
    uploads++;
  };
  cloud.list = async (fid) => {
    const items = await list(fid);
    if (!hidden) return items;
    const name = hidden;
    hidden = null;
    return items.filter((x) => x.filename !== name);
  };
  const service = new Service({
    quark: cloud,
    stateDir: path.join(root, "state"),
    checkGame: async () => {},
  });
  await service.upload(p);
  assert.equal(uploads, 2);
  assert.equal((await service.versions(p)).length, 1);
});
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
test("未同步过的本机可直接上传，由用户决定来源", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-first-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = {
    account: "76561198000000000",
    profile: "profile1",
    group: "modded",
    dir: path.join(root, "saves"),
  };
  await fs.mkdir(p.dir);
  await fs.writeFile(path.join(p.dir, "progress.save"), "first");
  const service = new Service({
    quark: new FakeCloud(path.join(root, "cloud")),
    stateDir: path.join(root, "state"),
    checkGame: async () => {},
    getEnvironment: async () => null,
  });
  assert.equal(await service.base(p), null);
  await service.upload(p);
  assert.equal((await service.versions(p)).length, 1);
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
test("云端版本保留完整角色战绩及上传时Mod环境", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-cloud-summary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = {
    account: "76561198000000000",
    profile: "profile1",
    group: "modded",
    dir: path.join(root, "saves"),
  };
  await fs.mkdir(p.dir);
  await fs.writeFile(
    path.join(p.dir, "progress.save"),
    JSON.stringify({
      character_stats: [
        {
          id: "CHARACTER.IRONCLAD",
          total_wins: 2,
          total_losses: 3,
          max_ascension: 4,
        },
        {
          id: "CHARACTER.DEFECT",
          total_wins: 7,
          total_losses: 1,
          max_ascension: 6,
        },
      ],
    }),
  );
  const environment = {
    gameVersion: "v-test",
    mods: {
      loaded: 2,
      detected: 3,
      source: "last-game-session",
      observedAt: "2026-10-31T00:00:00Z",
    },
  };
  const service = new Service({
    quark: new FakeCloud(path.join(root, "cloud")),
    stateDir: path.join(root, "state"),
    checkGame: async () => {},
    getEnvironment: async () => environment,
  });
  await service.upload(p);
  const [v] = await service.versions(p);
  assert.equal(v.summary.characters.length, 2);
  assert.equal(v.summary.wins, 9);
  assert.deepEqual(v.summary.environment, environment);
});
test("手动备份仅写本地并返回可恢复的备份ID，不调用夸克", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-local-backup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = {
    account: "76561198000000000",
    profile: "profile1",
    group: "vanilla",
    dir: path.join(root, "saves"),
  };
  await fs.mkdir(p.dir);
  await fs.writeFile(path.join(p.dir, "progress.save"), "local progress");
  const service = new Service({
    stateDir: path.join(root, "state"),
    checkGame: async () => {},
    getEnvironment: async () => null,
  });
  const message = await service.backup(p);
  const [id] = await service.backups(p);
  assert.ok(message.includes(id));
  assert.match(message, /仅保存在本机/);
  const s = JSON.parse(
    await fs.readFile(
      path.join(service.backupStore.root, id + ".json"),
      "utf8",
    ),
  );
  assert.equal(
    Buffer.from(s.files[0].data, "base64").toString(),
    "local progress",
  );
});
