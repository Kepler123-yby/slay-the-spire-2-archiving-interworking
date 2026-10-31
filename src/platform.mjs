import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export function saveRoot(
  platform = process.platform,
  home = os.homedir(),
  appdata = process.env.APPDATA,
) {
  if (platform === "darwin")
    return path.join(
      home,
      "Library",
      "Application Support",
      "SlayTheSpire2",
      "steam",
    );
  if (platform === "win32") {
    if (!appdata) throw Error("APPDATA 未设置");
    return path.join(appdata, "SlayTheSpire2", "steam");
  }
  throw Error("仅支持 macOS 与 Windows");
}
export async function discover(root = saveRoot()) {
  const out = [];
  for (const a of await fs
    .readdir(root, { withFileTypes: true })
    .catch(() => [])) {
    if (!a.isDirectory() || !/^\d{5,20}$/.test(a.name)) continue;
    for (const layout of ["shared", "modded"])
      for (const profile of ["profile1", "profile2", "profile3"]) {
        const dir = path.join(
          root,
          a.name,
          ...(layout === "modded" ? ["modded"] : []),
          profile,
          "saves",
        );
        const stat = await fs
          .lstat(path.join(dir, "progress.save"))
          .catch(() => null);
        const pending = await fs
          .lstat(path.join(path.dirname(dir), ".saves.spire-transaction.json"))
          .catch(() => null);
        if (stat?.isFile() || pending?.isFile())
          out.push({
            account: a.name,
            profile,
            layout,
            group: layout === "modded" ? "modded" : "vanilla",
            dir,
            pending: !!pending,
          });
      }
  }
  return out;
}
export async function assertGameClosed() {
  let running;
  try {
    if (process.platform === "darwin") {
      const { stdout } = await exec("/bin/ps", ["-axo", "comm="]);
      running = stdout
        .split("\n")
        .some((x) =>
          /\/SlayTheSpire2(?:\.app\/.*)?$|\/Slay the Spire 2(?:\.app\/.*)?$/i.test(
            x.trim(),
          ),
        );
    } else if (process.platform === "win32") {
      const { stdout } = await exec("tasklist.exe", ["/FO", "CSV", "/NH"]);
      running = /"(?:SlayTheSpire2|Slay the Spire 2)\.exe"/i.test(stdout);
    } else throw Error();
  } catch {
    throw Error("无法确认游戏状态，暂不允许写入");
  }
  if (running) throw Error("请先完全退出杀戮尖塔 2，再重试");
}
