import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSaveTask } from "../src/save-task.mjs";
import { Service } from "../src/service.mjs";
import { AgentManager } from "../src/agent-manager.mjs";

test("一个真实工作任务完成上传或刷新，跨任务复用缓存，刷新仍查询云端", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-save-job-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir);
  const p = {
    account: "76561198000000000",
    profile: "profile1",
    group: "modded",
    layout: "modded",
    dir: path.join(root, "saves"),
  };
  await fs.mkdir(p.dir);
  await fs.writeFile(path.join(p.dir, "progress.save"), "synthetic");
  let commands = 0,
    jobs = 0;
  const cloud = {
    async mkdir(name, parent = path.join(root, "cloud")) {
      commands++;
      const d = path.join(parent, name);
      await fs.mkdir(d, { recursive: true });
      return d;
    },
    async put(file, fid) {
      commands++;
      await fs.copyFile(file, path.join(fid, path.basename(file)));
    },
    async list(fid) {
      commands++;
      return Promise.all(
        (await fs.readdir(fid)).map(async (filename) => ({
          filename,
          fid: path.join(fid, filename),
          size: (await fs.stat(path.join(fid, filename))).size,
        })),
      );
    },
    async get(fid) {
      commands++;
      return fid;
    },
  };
  const adapter = {
    saveExecutor: async (task) => {
      jobs++;
      if (task.operation === "upload") {
        assert.equal(path.isAbsolute(task.file || ""), true);
        assert.equal(task.profile.dir, undefined);
        await fs.access(task.file);
      }
      return runSaveTask(
        {
          ...task,
          root: path.join(stateDir, "quark"),
          allowedStateRoot: stateDir,
        },
        {
          quark: cloud,
          checkGame: async () => {
            throw Error("Windows沙箱不能查询宿主进程");
          },
        },
      );
    },
  };
  const service = new Service({
    quark: adapter,
    stateDir,
    checkGame: async () => {},
  });
  await service.upload(p);
  assert.equal(jobs, 1);
  assert.equal(commands, 10);
  assert.equal((await service.versions(p)).length, 1);
  commands = 0;
  await service.versions(p);
  assert.equal(jobs, 3);
  assert.equal(commands, 1);
  await assert.rejects(
    runSaveTask({ operation: "delete", stateDir, allowedStateRoot: stateDir }),
    /任务/,
  );
  await assert.rejects(
    runSaveTask(
      {
        operation: "upload",
        stateDir,
        allowedStateRoot: stateDir,
        root: path.join(stateDir, "quark"),
        profile: p,
        file: path.join(root, "outside.snapshot.json"),
      },
      { quark: cloud },
    ),
    /目录/,
  );
  await assert.rejects(
    runSaveTask({
      operation: "versions",
      stateDir: root,
      allowedStateRoot: stateDir,
      root: path.join(stateDir, "quark"),
    }),
    /目录/,
  );
});

test("Agent适配器将整次操作交给一次runner，解绑清理批处理入口", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-save-adapter-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const q = {
    cli: path.join(root, "scripts/quark-drive.cjs"),
    workDir: path.join(root, "quark"),
  };
  const manager = new AgentManager({
    root,
    projectDir: process.cwd(),
    quark: q,
    allowedRoots: [root],
  });
  manager.binding = {
    version: 1,
    agent: "codex",
    cli: process.execPath,
    node: process.execPath,
    cwd: process.cwd(),
    threadId: "01234567-1234-1234-1234-123456789abc",
    model: "default",
    proxy: "",
  };
  manager.attach();
  const calls = [];
  manager.runner = {
    run: async (task) => {
      calls.push(task);
      return { value: [], cache: { folders: [], markers: [] } };
    },
  };
  await q.saveExecutor({
    operation: "versions",
    stateDir: root,
    profile: {
      account: "76561198000000000",
      profile: "profile1",
      group: "modded",
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "save");
  assert.equal(calls[0].allowedStateRoot, root);
  await manager.unbind();
  assert.equal(q.saveExecutor, null);
});
