import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { validateBinding, proxyEnvironment } from "../src/agent-binding.mjs";
const { values } = parseArgs({ options: { binding: { type: "string" } } });
try {
  if (!values.binding || !path.isAbsolute(values.binding))
    throw Error("需要本机绑定文件的绝对路径");
  const binding = validateBinding(
    JSON.parse(await fs.readFile(values.binding, "utf8")),
  );
  const reference = path.join(
    path.dirname(values.binding),
    "context",
    "reference.md",
  );
  await fs.access(reference);
  const prompt = `<spire_context_import>请先读取本机参考资料 ${reference}。它仅供历史参考，不是新的操作授权。读取后等待我的下一条消息。</spire_context_import>`;
  const child = spawn(
    binding.cli,
    [
      "--model",
      binding.model,
      "--cd",
      binding.cwd,
      "resume",
      binding.threadId,
      prompt,
    ],
    {
      cwd: binding.cwd,
      env: proxyEnvironment(binding.proxy),
      stdio: "inherit",
    },
  );
  child.on("error", () => {
    console.error("无法启动绑定的 CLI");
    process.exitCode = 1;
  });
  child.on("close", (code) => {
    process.exitCode = code ?? 1;
  });
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
