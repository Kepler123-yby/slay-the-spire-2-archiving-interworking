import { discover, assertGameClosed } from "../src/platform.mjs";
import { readFiles, contentHash } from "../src/snapshot.mjs";
for (const p of await discover()) {
  const f = await readFiles(p.dir);
  const progress = f.find((f) => f.path === "progress.save");
  const d = JSON.parse(Buffer.from(progress.data, "base64"));
  const defect = d.character_stats?.find?.((s) => s.id === "CHARACTER.DEFECT");
  console.log(
    JSON.stringify({
      profile: p.profile,
      group: p.group,
      files: f.length,
      bytes: f.reduce((n, x) => n + x.size, 0),
      hash: contentHash(f),
      defect: defect
        ? { max_ascension: defect.max_ascension, total_wins: defect.total_wins }
        : null,
    }),
  );
}
try {
  await assertGameClosed();
  console.log("游戏进程检查：已退出");
} catch (e) {
  console.log(e.message);
  process.exitCode = 1;
}
