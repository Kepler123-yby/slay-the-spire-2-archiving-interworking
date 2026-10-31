import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  BindingStore,
  validateBinding,
  proxyEnvironment,
} from "../src/agent-binding.mjs";
import { ordinaryEnvironment } from "../src/agent-runner.mjs";
import { validateQuarkTask } from "../src/agent-worker.mjs";
import { Quark } from "../src/quark.mjs";
const binding = {
  version: 1,
  agent: "codex",
  cli: process.execPath,
  node: process.execPath,
  cwd: process.cwd(),
  threadId: "01234567-1234-1234-1234-123456789abc",
  model: "account-default",
  proxy: "http://127.0.0.1:7897",
};
test("绑定只保留本机字段，拒绝凭据代理、相对路径及未知适配器", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-binding-"));
  try {
    const store = new BindingStore(root);
    assert.equal(await store.read(), null);
    await store.save({ ...binding, cookie: "never store" });
    assert.deepEqual(await store.read(), binding);
    assert.throws(() => validateBinding({ ...binding, agent: "unknown" }));
    assert.throws(() => validateBinding({ ...binding, cli: "relative" }));
    assert.throws(() =>
      validateBinding({ ...binding, proxy: "http://user:pass@localhost:7897" }),
    );
    const env = proxyEnvironment(binding.proxy, { KEEP: "x" });
    assert.equal(env.KEEP, "x");
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7897/");
    await store.clear();
    assert.equal(await store.read(), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("普通终端模拟只删除身份标识，保留真实登录配置且不新增身份", () => {
  assert.deepEqual(
    ordinaryEnvironment({
      CODEX_ENV: "1",
      CODEX_THREAD_ID: "old",
      AI_AGENT: "codex",
      CODEX_HOME: "/real/home",
      CODEX_API_KEY: "legitimate-inherited",
      PATH: "/bin",
    }),
    {
      CODEX_HOME: "/real/home",
      CODEX_API_KEY: "legitimate-inherited",
      PATH: "/bin",
    },
  );
});
test("worker 拒绝任意命令、删除及目录外上传", () => {
  const root = path.resolve(".data/mock");
  assert.doesNotThrow(() =>
    validateQuarkTask({
      root,
      args: ["upload", path.join(root, "save.json"), "--parent-fid", "123"],
    }),
  );
  for (const args of [
    ["delete", "123"],
    ["upload", path.resolve(".codex/auth.json"), "--parent-fid", "123"],
    ["browse", "--parent-fid", "123", "--all", "--task-dir", "/outside"],
  ])
    assert.throws(() => validateQuarkTask({ root, args }), /不允许/);
});

test("完整签名 FID 原样通过下载及目录操作，不当作本地文件路径", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-signed-fid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fid = "signed.v1:" + "A".repeat(160) + "+/=|file_123";
  for (const args of [
    ["download", "--fid", fid, "--output-dir", path.join(root, "downloads")],
    ["browse", "--parent-fid", fid, "--all", "--task-dir", root],
    ["create-folder", "--dir-path", "profile1", "--parent-fid", fid],
    ["upload", path.join(root, "snapshot.json"), "--parent-fid", fid],
  ])
    assert.doesNotThrow(() => validateQuarkTask({ root, args }));
  let downloads = 0;
  const quark = new Quark({
    workDir: root,
    executor: async (args) => {
      validateQuarkTask({ root, args });
      assert.equal(args[0], "download");
      assert.equal(args[2], fid);
      downloads++;
      await fs.writeFile(path.join(args[4], "snapshot.json"), "fixture");
      return [{ type: "result", code: 0, data: {} }];
    },
  });
  assert.equal(await fs.readFile(await quark.get(fid), "utf8"), "fixture");
  assert.equal(downloads, 1);
  for (const invalid of [
    "",
    " ",
    "a\nb",
    "a\0b",
    "--output-dir",
    "x".repeat(4097),
  ]) {
    assert.throws(
      () =>
        validateQuarkTask({
          root,
          args: [
            "download",
            "--fid",
            invalid,
            "--output-dir",
            path.join(root, "downloads"),
          ],
        }),
      /不允许|无效/,
    );
  }
  assert.throws(
    () =>
      validateQuarkTask({
        root,
        args: [
          "download",
          "--fid",
          fid,
          "--output-dir",
          path.join(root, "..", "outside"),
        ],
      }),
    /不允许/,
  );
});
