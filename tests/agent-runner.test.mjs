import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AgentRunner } from "../src/agent-runner.mjs";
const binding = {
  version: 1,
  agent: "codex",
  cli: process.execPath,
  node: process.execPath,
  cwd: process.cwd(),
  threadId: "01234567-1234-1234-1234-123456789abc",
  model: "default",
  proxy: "",
};
async function fakeRunner(mode) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-runner-"));
  const runner = new AgentRunner({
    binding,
    root,
    timeout: 20,
    spawnProcess(cli, args, options) {
      const child = new EventEmitter();
      Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() {
          queueMicrotask(() => child.emit("close", 1));
        },
      });
      queueMicrotask(async () => {
        if (mode === "hang") return;
        const request = JSON.parse(
          await fs.readFile(path.join(options.cwd, "request.json"), "utf8"),
        );
        const nonce = mode === "wrong" ? "wrong" : request.nonce;
        await fs.writeFile(
          request.output,
          JSON.stringify({ nonce, ok: true, data: { passed: true } }),
        );
        const event =
          mode === "text"
            ? {
                type: "item.completed",
                item: { type: "agent_message", text: "done" },
              }
            : {
                type: "item.completed",
                item: {
                  type: "command_execution",
                  command: "node agent-worker.mjs",
                  aggregated_output: "SPIRE_JOB_DONE:" + request.nonce,
                  exit_code: 0,
                },
              };
        child.stdout.write(JSON.stringify(event) + "\n");
        child.emit("close", 0);
      });
      return child;
    },
  });
  return { root, runner };
}
test("实际工作结果通过，纯模型文字及错任务结果不通过", async () => {
  for (const mode of ["valid", "text", "wrong", "hang"]) {
    const { root, runner } = await fakeRunner(mode);
    try {
      if (mode === "valid")
        assert.deepEqual(await runner.run({ kind: "check" }), { passed: true });
      else
        await assert.rejects(
          runner.run({ kind: "check" }),
          /实际执行|不匹配|超时/,
        );
      assert.equal(runner.busy, false);
      assert.deepEqual(await fs.readdir(path.join(root, "jobs")), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
test("取消不会执行新任务", async () => {
  const { root, runner } = await fakeRunner("hang");
  try {
    await assert.rejects(
      runner.run({}, { signal: AbortSignal.abort() }),
      /取消/,
    );
    assert.equal(runner.busy, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
