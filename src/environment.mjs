import fs from "node:fs/promises";
import path from "node:path";
import { saveRoot } from "./platform.mjs";
export function parseEnvironment(log, observedAt) {
  const matches = [...log.matchAll(/Loaded (\d+) mods \((\d+) total\)/g)];
  const match = matches.at(-1);
  const versions = [...log.matchAll(/Release Version:\s*([^\r\n]+)/g)];
  const loaded = match ? Number(match[1]) : null;
  const detected = match ? Number(match[2]) : null;
  return {
    gameVersion: versions.at(-1)?.[1]?.trim().slice(0, 80) || null,
    mods:
      loaded !== null && detected >= loaded
        ? { loaded, detected, source: "last-game-session", observedAt }
        : null,
  };
}
export async function readEnvironment(logDir) {
  try {
    const file = path.join(
      logDir || path.join(path.dirname(saveRoot()), "logs"),
      "godot.log",
    );
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
      return { gameVersion: null, mods: null };
    return parseEnvironment(
      await fs.readFile(file, "utf8"),
      stat.mtime.toISOString(),
    );
  } catch {
    return { gameVersion: null, mods: null };
  }
}
