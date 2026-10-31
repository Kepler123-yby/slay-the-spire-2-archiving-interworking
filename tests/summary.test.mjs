import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { summarize } from "../src/summary.mjs";
import { parseEnvironment, readEnvironment } from "../src/environment.mjs";
import { capture } from "../src/snapshot.mjs";
import { model, modsLabel, winRate } from "../ui/summary-model.mjs";
const progress = {
  total_playtime: 7200,
  character_stats: [
    {
      id: "CHARACTER.IRONCLAD",
      total_wins: 9,
      total_losses: 3,
      max_ascension: 10,
    },
    {
      id: "CHARACTER.DEFECT",
      total_wins: 6,
      total_losses: 4,
      max_ascension: 5,
    },
    {
      id: "CHARACTER.MY_MOD",
      total_wins: 1,
      total_losses: 0,
      max_ascension: 2,
    },
    { id: "CHARACTER.RANDOM_CHARACTER", total_wins: 0, total_losses: 0 },
  ],
};
test("摘要包含所有真实角色及Mod角色，区分胜利与进阶，排除随机占位符", () => {
  const s = summarize(progress);
  assert.equal(s.characters.length, 3);
  assert.equal(s.wins, 16);
  assert.equal(s.losses, 7);
  assert.equal(s.playtimeSeconds, 7200);
  assert.equal(
    s.characters.find((c) => c.id === "CHARACTER.DEFECT").ascension,
    5,
  );
  assert.equal(s.characters.find((c) => c.id === "CHARACTER.DEFECT").wins, 6);
  assert.equal(winRate(model(s).characters[0]), "75%");
});
test("Mod数来自最后启动记录，不将没有日志误判为0个", async () => {
  const e = parseEnvironment(
    "Release Version: v0.111.0\nLoaded 2 mods (3 total)\nLoaded 27 mods (29 total)",
    "2026-10-31T00:00:00Z",
  );
  assert.equal(e.mods.loaded, 27);
  assert.equal(e.mods.detected, 29);
  assert.equal(e.mods.source, "last-game-session");
  assert.equal(e.gameVersion, "v0.111.0");
  assert.equal(parseEnvironment("").mods, null);
  assert.equal((await readEnvironment("/not-a-real-log-folder")).mods, null);
  assert.equal(modsLabel({ mods: null }), "Mod 数量未记录");
});
test("缺失字段和旧版摘要显示未记录，不补造胜负与Mod数", () => {
  const s = summarize({ character_stats: [{ id: "CHARACTER.REGENT" }] });
  assert.equal(s.wins, null);
  assert.equal(s.characters[0].ascension, null);
  const old = model({ defectAscension: 5, defectWins: 7 });
  assert.equal(old.complete, false);
  assert.equal(old.characters.length, 1);
  assert.equal(old.losses, null);
  assert.equal(modsLabel(old.environment), "Mod 数量未记录");
});
test("上传快照保留角色表、Mod数量及来源时间，不影响原存档字节", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spire-summary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "saves");
  await fs.mkdir(dir);
  const original = JSON.stringify(progress);
  await fs.writeFile(path.join(dir, "progress.save"), original);
  const environment = parseEnvironment(
    "Loaded 27 mods (29 total)",
    "2026-10-31T00:00:00Z",
  );
  const s = await capture(
    dir,
    { account: "76561198000000000", profile: "profile1" },
    [],
    environment,
  );
  assert.equal(s.summary.characters.length, 3);
  assert.equal(s.summary.environment.mods.loaded, 27);
  assert.equal(s.summary.environment.mods.observedAt, "2026-10-31T00:00:00Z");
  assert.ok(s.summary.modifiedAt);
  assert.equal(
    await fs.readFile(path.join(dir, "progress.save"), "utf8"),
    original,
  );
});
