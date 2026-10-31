import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { readCodexSession } from "../src/codex-session.mjs";
import { atomicJSON } from "../src/snapshot.mjs";

const { values } = parseArgs({
  options: {
    thread: { type: "string" },
    cwd: { type: "string" },
    output: { type: "string" },
    cli: { type: "string" },
  },
});
try {
  const cwd = path.resolve(values.cwd || process.cwd());
  const output = path.resolve(
    values.output || ".data/project-context/project-dialogue.json",
  );
  // Export is an explicit local operation. Nothing is uploaded by this command.
  const { archive, reader } = await readCodexSession({
    threadId: values.thread || process.env.CODEX_THREAD_ID,
    cwd,
    candidates: values.cli ? [path.resolve(values.cli)] : undefined,
  });
  await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await atomicJSON(output, archive);
  await fs.chmod(output, 0o600);
  console.log(
    JSON.stringify(
      {
        ok: true,
        messages: archive.messages.length,
        reader,
        output,
        uploaded: false,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
}
