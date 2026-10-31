import { summarize } from "../src/summary.mjs";
import { readEnvironment } from "../src/environment.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { discover, assertGameClosed } from "../src/platform.mjs";
import { readFiles, contentHash } from "../src/snapshot.mjs";
for (const p of await discover()) {
  const f = await readFiles(p.dir);
  const progress = f.find((f) => f.path === "progress.save");
  const d = JSON.parse(Buffer.from(progress.data, "base64"));
  console.log(
    JSON.stringify({
      profile: p.profile,
      group: p.group,
      files: f.length,
      bytes: f.reduce((n, x) => n + x.size, 0),
      hash: contentHash(f),
      summary: summarize(d, {
        environment: await readEnvironment(),
        modifiedAt: (
          await fs.stat(path.join(p.dir, "progress.save"))
        ).mtime.toISOString(),
      }),
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
