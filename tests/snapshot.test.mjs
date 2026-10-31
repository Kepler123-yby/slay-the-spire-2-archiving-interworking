import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  capture,
  validate,
  apply,
  contentHash,
  readFiles,
  safePath,
  recover,
} from "../src/snapshot.mjs";
const identity = {
  account: "76561198000000000",
  profile: "profile1",
  device: "test",
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "saves");
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "progress.save"), "old");
  await fs.writeFile(path.join(dir, "prefs.save"), "local prefs");
  return { root, dir };
}
test("损坏内容与路径穿越在应用前被拒绝", async (t) => {
  const { dir } = await fixture(t);
  const s = await capture(dir, identity);
  s.files[0].data = "bmV3";
  assert.throws(() => validate(s), /校验/);
  for (const p of ["../x", "C:/x", "/x", "a\\b", "CON.save", "history/a."])
    assert.throws(() => safePath(p));
});
test("恢复完整集合、删除旧对局且保留本机偏好", async (t) => {
  const { root, dir } = await fixture(t);
  const s = await capture(dir, identity);
  await fs.writeFile(path.join(dir, "progress.save"), "new");
  await fs.writeFile(path.join(dir, "current_run.save"), "run");
  await apply(dir, s, path.join(root, "state"));
  assert.equal(
    await fs.readFile(path.join(dir, "progress.save"), "utf8"),
    "old",
  );
  assert.equal(
    await fs.readFile(path.join(dir, "prefs.save"), "utf8"),
    "local prefs",
  );
  await assert.rejects(fs.access(path.join(dir, "current_run.save")));
  assert.equal((await fs.readdir(path.join(root, "state/backups"))).length, 1);
});
test("写入中断后回滚到原进度", async (t) => {
  const { root, dir } = await fixture(t);
  const s = await capture(dir, identity);
  await fs.writeFile(path.join(dir, "progress.save"), "new");
  await assert.rejects(
    apply(dir, s, path.join(root, "state"), {
      checkpoint: (phase) => {
        if (phase === "old-moved") throw Error("模拟断电");
      },
    }),
    /模拟断电/,
  );
  assert.equal(
    await fs.readFile(path.join(dir, "progress.save"), "utf8"),
    "new",
  );
  assert.equal(await recover(dir), false);
});
test("符号链接和未知文件拒绝同步", async (t) => {
  const { root, dir } = await fixture(t);
  await fs.symlink(path.join(dir, "prefs.save"), path.join(dir, "bad.save"));
  await assert.rejects(readFiles(dir), /符号链接/);
  await fs.rm(path.join(dir, "bad.save"));
  await fs.writeFile(path.join(dir, "unknown.dat"), "x");
  await assert.rejects(readFiles(dir), /尚未识别/);
});
test("大小写冲突和空进度拒绝应用", async (t) => {
  const { dir } = await fixture(t);
  const s = await capture(dir, identity);
  s.files.push({ ...s.files[0], path: "Progress.save" });
  assert.throws(() => validate(s), /重复/);
  s.files = [];
  s.contentHash = contentHash([]);
  assert.throws(() => validate(s), /空存档/);
});
test("存档根目录或父目录为符号链接时不改动真实目标", async (t) => {
  const { root, dir } = await fixture(t);
  const s = await capture(dir, identity);
  const link = path.join(root, "linked-saves");
  await fs.symlink(dir, link);
  await assert.rejects(apply(link, s, path.join(root, "state")), /符号链接/);
  assert.equal(
    await fs.readFile(path.join(dir, "progress.save"), "utf8"),
    "old",
  );
  const parentLink = path.join(root, "linked-parent");
  await fs.symlink(root, parentLink);
  await assert.rejects(readFiles(path.join(parentLink, "saves")), /符号链接/);
});
test("提交后的旧目录清理失败不将已成功应用误报为失败", async (t) => {
  const { root, dir } = await fixture(t);
  const s = await capture(dir, identity);
  await fs.writeFile(path.join(dir, "progress.save"), "new");
  const rm = fs.rm;
  fs.rm = async function (p, options) {
    if (String(p).includes(".spire-old-")) throw Error("占用");
    return rm.call(this, p, options);
  };
  try {
    await apply(dir, s, path.join(root, "state"));
    assert.equal(
      await fs.readFile(path.join(dir, "progress.save"), "utf8"),
      "old",
    );
  } finally {
    fs.rm = rm;
  }
});
