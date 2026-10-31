import { spawn } from "node:child_process";
const p = spawn(
  process.execPath,
  [".runtime/quark/scripts/quark-drive.cjs", "login"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let buffer = "";
p.stdout.on("data", (data) => {
  buffer += data;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    try {
      const e = JSON.parse(line);
      console.log(
        JSON.stringify({
          type: e.type,
          code: e.code,
          action: e.action,
          msg: e.msg,
          status: e.data?.status,
          notice: e.notice,
        }),
      );
    } catch {
      console.log("官方工具正在等待浏览器授权");
    }
  }
});
p.stderr.on("data", () => {});
p.on("exit", (code) => {
  console.log("登录流程退出：" + code);
  process.exitCode = code;
});
