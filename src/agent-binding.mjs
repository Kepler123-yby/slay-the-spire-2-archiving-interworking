import fs from "node:fs/promises";
import path from "node:path";
import { atomicJSON } from "./snapshot.mjs";

export function proxyEnvironment(proxy, base = process.env) {
  if (!proxy) return { ...base };
  const url = new URL(proxy);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error("代理应为不含账号口令的 http(s) 地址");
  return {
    ...base,
    HTTP_PROXY: url.href,
    HTTPS_PROXY: url.href,
    http_proxy: url.href,
    https_proxy: url.href,
  };
}
export function validateBinding(binding) {
  if (
    binding?.version !== 1 ||
    binding.agent !== "codex" ||
    !path.isAbsolute(binding.cli || "") ||
    !path.isAbsolute(binding.node || "") ||
    !path.isAbsolute(binding.cwd || "") ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
      binding.threadId || "",
    ) ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(binding.model || "")
  )
    throw Error("本机 Agent 绑定无效");
  proxyEnvironment(binding.proxy);
  return {
    version: 1,
    agent: "codex",
    cli: binding.cli,
    node: binding.node,
    cwd: binding.cwd,
    threadId: binding.threadId,
    model: binding.model,
    proxy: binding.proxy || "",
  };
}
export class BindingStore {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, "agent-binding.json");
  }
  async read() {
    try {
      return validateBinding(JSON.parse(await fs.readFile(this.file, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async save(binding) {
    const safe = validateBinding(binding);
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await atomicJSON(this.file, safe);
    await fs.chmod(this.file, 0o600);
    return safe;
  }
  async clear() {
    await fs.rm(this.file, { force: true });
  }
}
