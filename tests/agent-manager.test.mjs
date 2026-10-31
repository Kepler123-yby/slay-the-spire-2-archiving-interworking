import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AgentManager } from "../src/agent-manager.mjs";
import { AgentRunner } from "../src/agent-runner.mjs";
import { spawn } from "node:child_process";
import { PROJECT_ID, messageFromItem } from "../src/project-dialogue.mjs";
const threadId = "01234567-1234-1234-1234-123456789abc";
const archive = {
  schemaVersion: 1,
  project: PROJECT_ID,
  messages: [
    messageFromItem(
      {
        item: {
          type: "userMessage",
          id: "m",
          content: [{ type: "text", text: "项目消息" }],
        },
      },
      { agent: "codex", threadId },
    ),
  ],
};
async function fixture(options) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-manager-"));
  const manager = new AgentManager({
    root,
    projectDir: process.cwd(),
    quark: {},
    findCLIs: async () => [process.execPath],
    ...options,
  });
  manager.binding = { threadId, cwd: process.cwd() };
  return { root, manager };
}
test("自动检查相同失败内容不循环调用模型，也不清除错误或待办", async () => {
  const { root, manager } = await fixture({
    readSession: async () => ({ archive }),
  });
  let runs = 0;
  manager.runner = {
    run: async () => {
      runs++;
      throw Error("网络失败");
    },
  };
  try {
    await assert.rejects(manager.sync(), /网络失败/);
    assert.equal((await manager.status()).pending, true);
    assert.deepEqual(await manager.sync({ onlyChanged: true }), {
      unchanged: true,
    });
    assert.equal(runs, 1);
    assert.equal(manager.error, "网络失败");
    assert.equal(manager.stage, "云端未就绪，待同步内容保留");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("读取阶段和官方登录阶段均可取消并释放 busy", async () => {
  const wait = (signal) =>
    new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => reject(Error("已取消")), {
        once: true,
      }),
    );
  const { root, manager } = await fixture({
    readSession: async ({ signal }) => wait(signal),
    execLogin: async (cli, args, { signal }) => wait(signal),
  });
  try {
    const sync = manager.sync();
    manager.stop();
    await assert.rejects(sync, /取消/);
    assert.equal(manager.busy, false);
    const login = manager.login({});
    await new Promise((r) => setImmediate(r));
    manager.stop();
    await assert.rejects(login, /登录未完成/);
    assert.equal(manager.busy, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("打包应用的工作入口与继续对话脚本使用独立的Node可读资源", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "spire-packaged-agent-"),
  );
  try {
    const worker = path.join(
      root,
      "resources/agent-runtime/src/agent-worker.mjs",
    );
    const continueScript = path.join(
      root,
      "resources/agent-runtime/scripts/continue-bound-agent.mjs",
    );
    const manager = new AgentManager({
      root,
      projectDir: process.cwd(),
      quark: { cli: path.join(root, "quark/scripts/quark-drive.cjs") },
      worker,
      continueScript,
    });
    manager.binding = {
      version: 1,
      agent: "codex",
      cli: process.execPath,
      node: process.execPath,
      cwd: process.cwd(),
      threadId,
      model: "default",
      proxy: "",
    };
    manager.attach();
    assert.equal(manager.runner.worker, worker);
    assert(manager.continueCommand().includes(continueScript));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("手动存档操作暂停后台读取，并在操作完成前阻止自动同步抢占", async () => {
  let started;
  const reading = new Promise((resolve) => {
    started = resolve;
  });
  const { root, manager } = await fixture({
    readSession: async ({ signal }) => {
      started();
      return new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => reject(Error("已取消")), {
          once: true,
        }),
      );
    },
  });
  try {
    const background = manager.sync({ background: true });
    await reading;
    assert.equal((await manager.status()).background, true);
    const release = await manager.prioritizeSave();
    assert.deepEqual(await background, { deferred: true });
    assert.equal(manager.busy, false);
    assert.equal(manager.attemptedHash, null);
    assert.deepEqual(await manager.sync({ background: true }), {
      deferred: true,
    });
    release();
    release();
    assert.equal(manager.foregroundRequests, 0);
  } finally {
    manager.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("手动操作等待后台Agent实际退出，保留待同步内容并可再次自动同步", async () => {
  const { root, manager } = await fixture({
    readSession: async () => ({ archive }),
  });
  let began,
    runs = 0;
  const executing = new Promise((resolve) => {
    began = resolve;
  });
  manager.runner = {
    busy: false,
    run: async (task, { signal }) => {
      runs++;
      if (runs > 1) throw Error("测试重试");
      manager.runner.busy = true;
      began();
      return new Promise((resolve, reject) =>
        signal.addEventListener(
          "abort",
          () =>
            setTimeout(() => {
              manager.runner.busy = false;
              reject(Error("已取消"));
            }, 15),
          { once: true },
        ),
      );
    },
    stop() {},
  };
  try {
    const background = manager.sync({ background: true });
    await executing;
    const release = await manager.prioritizeSave();
    assert.equal(manager.runner.busy, false);
    assert.deepEqual(await background, { deferred: true });
    assert.equal((await manager.status()).pending, true);
    release();
    await assert.rejects(
      manager.sync({ background: true, onlyChanged: true }),
      /测试重试/,
    );
    assert.equal(runs, 2);
    manager.busy = true;
    await assert.rejects(manager.prioritizeSave(), /等待/);
    assert.equal(manager.foregroundRequests, 0);
  } finally {
    manager.busy = false;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("后台抢占会终止真实子进程并释放任务目录", async () => {
  const { root, manager } = await fixture({
    readSession: async () => ({ archive }),
  });
  manager.binding = {
    version: 1,
    agent: "codex",
    cli: process.execPath,
    node: process.execPath,
    cwd: process.cwd(),
    threadId,
    model: "default",
    proxy: "",
  };
  let ready, child;
  const spawned = new Promise((resolve) => {
    ready = resolve;
  });
  manager.runner = new AgentRunner({
    binding: manager.binding,
    root,
    timeout: 10000,
    spawnProcess() {
      child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      child.once("spawn", ready);
      return child;
    },
  });
  try {
    const background = manager.sync({ background: true });
    await spawned;
    const release = await manager.prioritizeSave();
    assert.deepEqual(await background, { deferred: true });
    assert.equal(manager.runner.busy, false);
    assert(child.exitCode !== null || child.signalCode !== null);
    assert.deepEqual(await fs.readdir(path.join(root, "jobs")), []);
    release();
  } finally {
    child?.kill("SIGKILL");
    await fs.rm(root, { recursive: true, force: true });
  }
});
