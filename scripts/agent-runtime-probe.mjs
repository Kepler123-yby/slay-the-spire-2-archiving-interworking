import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { BindingStore } from "../src/agent-binding.mjs";
import { AgentRunner } from "../src/agent-runner.mjs";
const appData =
  process.platform === "darwin"
    ? path.join(os.homedir(), "Library/Application Support")
    : process.env.APPDATA || path.join(os.homedir(), ".config");
const root = path.join(appData, "SpireSaveBridge", "agent");
try {
  const binding = await new BindingStore(root).read();
  if (!binding) throw Error("尚未绑定，请先在界面预览并绑定本机项目会话");
  const cli = fileURLToPath(
    new URL("../.runtime/quark/scripts/quark-drive.cjs", import.meta.url),
  );
  const runner = new AgentRunner({
    binding,
    root,
    allowedRoots: [root, path.dirname(path.dirname(cli))],
  });
  const data = await runner.run({
    kind: "check",
    cli,
    root: path.join(root, "probe"),
  });
  console.log(
    JSON.stringify(
      { passed: true, ...data, model: binding.model, uploaded: false },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
