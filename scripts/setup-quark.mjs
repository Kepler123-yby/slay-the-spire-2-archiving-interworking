import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const version = "1.0.25",
  url =
    "https://pdds.quark.cn/download/stfile/eekkigineefiegmgo/quarkclouddrive-1.0.25.zip";
const root = path.resolve(".runtime/quark");
await fs.mkdir(root, { recursive: true });
const response = await fetch(url);
if (!response.ok) throw Error("下载官方工具失败：" + response.status);
const bytes = Buffer.from(await response.arrayBuffer());
if (
  createHash("sha256").update(bytes).digest("hex") !==
  "56c34e9a9313ae29d39475b4ff9da9e92fbfd59699bf5843e3382e54434fffb8"
)
  throw Error("官方组件下载校验失败");
const zip = path.resolve(".runtime/quark.zip");
await fs.writeFile(zip, bytes);
if (process.platform === "win32")
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Expand-Archive -LiteralPath $env:SPIRE_QUARK_ZIP -DestinationPath $env:SPIRE_QUARK_DIR -Force",
    ],
    { env: { ...process.env, SPIRE_QUARK_ZIP: zip, SPIRE_QUARK_DIR: root } },
  );
else execFileSync("/usr/bin/unzip", ["-qo", zip, "-d", root]);
await fs.writeFile(
  path.join(root, "source.json"),
  JSON.stringify(
    { version, url, sha256: createHash("sha256").update(bytes).digest("hex") },
    null,
    2,
  ),
);
console.log(
  "官方夸克组件 " + version + " 已安装在项目运行目录；没有运行全局安装脚本。",
);
