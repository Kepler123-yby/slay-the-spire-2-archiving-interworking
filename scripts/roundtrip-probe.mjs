import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Quark } from "../src/quark.mjs";
import { Service } from "../src/service.mjs";
const root = path.resolve(".data/roundtrip", randomUUID());
const q = new Quark({ workDir: path.join(root, "quark"), notify: console.log });
const cloud = {
  mkdir: (name, parent) =>
    q.mkdir(
      name === "STS2-SaveSync" ? "STS2-SaveSync-Validation" : name,
      parent,
    ),
  list: (fid) => q.list(fid),
  put: (file, fid) => q.put(file, fid),
  get: (fid) => q.get(fid),
};
const dir = path.join(root, "fixture", "saves");
await fs.mkdir(dir, { recursive: true });
const p = {
  account: String(Date.now()),
  profile: "profile1",
  group: "modded",
  dir,
};
const progress = (n) =>
  JSON.stringify({
    character_stats: [
      { id: "CHARACTER.DEFECT", max_ascension: n, total_wins: 7 },
    ],
  });
await fs.writeFile(path.join(dir, "progress.save"), progress(6));
await fs.writeFile(path.join(dir, "prefs.save"), "local preference");
const s = new Service({
  quark: cloud,
  stateDir: path.join(root, "state"),
  checkGame: async () => {},
});
try {
  await s.upload(p);
  const versions = await s.versions(p);
  if (
    versions.length !== 1 ||
    versions[0].summary.characters.find((c) => c.id === "CHARACTER.DEFECT")
      ?.ascension !== 6
  )
    throw Error("云端版本摘要验证失败");
  await fs.writeFile(path.join(dir, "progress.save"), progress(5));
  await s.download(p, versions[0].id, true);
  if (
    JSON.parse(await fs.readFile(path.join(dir, "progress.save")))
      .character_stats[0].max_ascension !== 6
  )
    throw Error("应用后进阶不匹配");
  if (
    (await fs.readFile(path.join(dir, "prefs.save"), "utf8")) !==
    "local preference"
  )
    throw Error("本地偏好被覆盖");
  const backups = await s.backups(p);
  await s.restore(p, backups[0], true);
  if (
    JSON.parse(await fs.readFile(path.join(dir, "progress.save")))
      .character_stats[0].max_ascension !== 5
  )
    throw Error("备份恢复失败");
  console.log(
    "REAL_CLOUD_ROUNDTRIP_OK: 合成 Mod 存档进阶 6 上传 → 云端回读 → 本地进阶 5 更新为 6 → 备份恢复为 5；真实用户存档未改动。",
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
