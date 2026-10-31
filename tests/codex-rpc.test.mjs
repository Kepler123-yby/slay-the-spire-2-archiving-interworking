import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CodexRPC } from "../src/codex-rpc.mjs";
function fake() {
  const child = new EventEmitter();
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: 0,
    kill() {
      this.killed++;
      queueMicrotask(() => this.emit("close", 0));
    },
  });
  return child;
}
test("JSON RPC 跨数据块响应，匹配 ID 且忽略通知", async () => {
  const child = fake();
  const rpc = new CodexRPC("fake", { spawnProcess: () => child });
  const pending = rpc.request("thread/read", {});
  child.stdout.write('{"method":"notice"}\n{"id":1,"res');
  child.stdout.write('ult":{"ok":true}}\n');
  assert.deepEqual(await pending, { ok: true });
  assert.equal(rpc.pending.size, 0);
  rpc.close();
});
test("接口错误保留协议 code，超时会终止自建进程", async () => {
  const child = fake(),
    rpc = new CodexRPC("fake", { spawnProcess: () => child, timeout: 10 });
  const first = rpc.request("old", {});
  child.stdout.write(
    '{"id":1,"error":{"code":-32601,"message":"unsupported"}}\n',
  );
  await assert.rejects(first, (e) => e.code === -32601);
  await assert.rejects(rpc.request("hang", {}), /超时/);
  assert.equal(child.killed, 1);
  assert.equal(rpc.pending.size, 0);
});
test("损坏协议不继续读取或保留挂起任务", async () => {
  const child = fake(),
    rpc = new CodexRPC("fake", { spawnProcess: () => child });
  const pending = rpc.request("read");
  child.stdout.write("not json\n");
  await assert.rejects(pending, /无效 JSON/);
  assert.equal(rpc.closed, true);
});
