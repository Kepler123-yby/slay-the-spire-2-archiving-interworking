import { packager } from "@electron/packager";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  version = require("electron/package.json").version;
const platform = process.argv[2] || process.platform,
  arch = platform === "win32" ? "x64" : process.arch;
let electronZipDir = process.env.ELECTRON_ZIP_DIR;
if (!electronZipDir && process.platform === "darwin" && platform === "darwin") {
  const cache = path.join(os.homedir(), "Library/Caches/electron");
  for (const dir of await fs.readdir(cache).catch(() => [])) {
    const at = path.join(cache, dir);
    try {
      await fs.access(
        path.join(at, `electron-v${version}-${platform}-${arch}.zip`),
      );
      electronZipDir = at;
      break;
    } catch {}
  }
}
// Package only distributable component scripts, never its authorization/task caches.
const quarkResource = path.resolve(".data/pack-resources/quark");
await fs.rm(quarkResource, { recursive: true, force: true });
await fs.mkdir(path.join(quarkResource, "scripts"), { recursive: true });
for (const name of ["quark-drive.cjs", "hash-worker.cjs"])
  await fs.copyFile(
    path.join(".runtime/quark/scripts", name),
    path.join(quarkResource, "scripts", name),
  );
// External Node.js cannot load app.asar. Keep worker modules as ordinary files.
const agentResource = path.resolve(".data/pack-resources/agent-runtime");
if (path.dirname(agentResource) !== path.resolve(".data/pack-resources"))
  throw Error("Unexpected Agent resource directory");
await fs.rm(agentResource, { recursive: true, force: true });
await fs.mkdir(path.join(agentResource, "src"), { recursive: true });
await fs.mkdir(path.join(agentResource, "scripts"), { recursive: true });
for (const name of await fs.readdir("src"))
  if (name.endsWith(".mjs"))
    await fs.copyFile(
      path.join("src", name),
      path.join(agentResource, "src", name),
    );
await fs.copyFile(
  "scripts/continue-bound-agent.mjs",
  path.join(agentResource, "scripts/continue-bound-agent.mjs"),
);
const result = await packager({
  dir: ".",
  name: "SpireSaveBridge",
  platform,
  arch,
  electronVersion: version,
  electronZipDir,
  out: "dist",
  overwrite: true,
  extraResource: [quarkResource, agentResource],
  ignore: [
    /^\/dist(?:\/|$)/,
    /^\/tests(?:\/|$)/,
    /^\/\.git(?:\/|$)/,
    /^\/\.data(?:\/|$)/,
    /^\/\.runtime(?:\/|$)/,
    /^\/node_modules(?:\/|$)/,
  ],
  prune: false,
});
console.log(result.join("\n"));
