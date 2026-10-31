import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AgentManager } from "../src/agent-manager.mjs";
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
