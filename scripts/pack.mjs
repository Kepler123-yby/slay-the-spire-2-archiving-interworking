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
const result = await packager({
  dir: ".",
  name: "SpireSaveBridge",
  platform,
  arch,
  electronVersion: version,
  electronZipDir,
  out: "dist",
  overwrite: true,
  extraResource: [".runtime/quark"],
  ignore: [
    /^\/dist(?:\/|$)/,
    /^\/tests(?:\/|$)/,
    /^\/\.git(?:\/|$)/,
    /^\/\.data(?:\/|$)/,
    /^\/node_modules(?:\/|$)/,
  ],
  prune: false,
});
console.log(result.join("\n"));
