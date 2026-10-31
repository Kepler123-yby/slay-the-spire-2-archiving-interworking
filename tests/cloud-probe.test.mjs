import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probe } from "../scripts/cloud-probe.mjs";

test("上传完成后目录延迟可见，探针等待目标文件再下载校验", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-probe-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let uploaded, reads = 0;
  const cloud = {
    mkdir: async () => "folder",
    put: async (file) => { uploaded = file; },
    list: async () => ++reads === 1 ? [] : [{ filename: path.basename(uploaded), fid: "file" }],
    get: async () => uploaded,
  };
  assert.equal((await probe(cloud, root)).passed, true);
  assert.equal(reads, 2);
});
