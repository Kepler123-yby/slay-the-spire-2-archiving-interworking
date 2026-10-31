import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { ContextSync } from "../src/context-sync.mjs";
import { PROJECT_ID, messageFromItem } from "../src/project-dialogue.mjs";
const archive = (text) => ({
  schemaVersion: 1,
  project: PROJECT_ID,
  messages: [
    messageFromItem(
      {
        item: {
          type: "userMessage",
          id: text,
          content: [{ type: "text", text }],
        },
      },
      { agent: "codex", threadId: "01234567-1234-1234-1234-123456789abc" },
    ),
  ],
});
class MemoryQuark {
  constructor(root) {
    this.root = root;
    this.folders = new Map();
    this.files = new Map();
    this.uploads = 0;
  }
  async mkdir(name, parent = "0") {
    const key = parent + "/" + name;
    if (!this.folders.has(key)) this.folders.set(key, randomUUID());
    return this.folders.get(key);
  }
  async list(parent) {
    return [...this.files.values()]
      .filter((f) => f.parent === parent)
      .map(({ bytes, ...item }) => ({ ...item, size: bytes.length }));
  }
  async put(file, parent) {
    if (this.fail && file.endsWith(".ready.json")) throw Error("发布失败");
    const fid = randomUUID();
    this.files.set(fid, {
      fid,
      parent,
      filename: path.basename(file),
      bytes: await fs.readFile(file),
    });
    this.uploads++;
  }
  async get(fid) {
    const file = path.join(this.root, "download-" + randomUUID());
    await fs.writeFile(file, this.files.get(fid).bytes);
    return file;
  }
}
test("两台设备恢复并合并对话，无变化不重复上传", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-context-")),
    q = new MemoryQuark(root);
  try {
    const a = new ContextSync({ quark: q, root: path.join(root, "a") });
    const b = new ContextSync({ quark: q, root: path.join(root, "b") });
    assert.equal((await a.sync(archive("A"))).messages, 1);
    assert.equal((await b.sync(archive("B"))).messages, 2);
    const count = q.uploads;
    const result = await a.sync(archive("A"));
    assert.equal(result.messages, 2);
    assert.equal(result.uploaded, false);
    assert.equal(q.uploads, count);
    const merged = JSON.parse(
      await fs.readFile(path.join(root, "a/merged.json"), "utf8"),
    );
    assert.deepEqual(
      new Set(merged.messages.map((m) => m.text)),
      new Set(["A", "B"]),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("发布失败保留待办，坏哈希不改写成功记录", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-context-fail-")),
    q = new MemoryQuark(root);
  try {
    const sync = new ContextSync({ quark: q, root: path.join(root, "local") });
    q.fail = true;
    await assert.rejects(sync.sync(archive("A")), /发布失败/);
    assert.equal((await sync.read("merged.json")).messages.length, 1);
    assert.equal(await sync.read("sync-state.json"), null);
    q.fail = false;
    await sync.sync(archive("A"));
    const previous = await sync.read("sync-state.json");
    const file = [...q.files.values()].findLast((f) =>
      f.filename.endsWith(".context.json"),
    );
    file.bytes = Buffer.from("corrupt");
    await assert.rejects(sync.sync(archive("A")), /哈希/);
    assert.deepEqual(await sync.read("sync-state.json"), previous);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
