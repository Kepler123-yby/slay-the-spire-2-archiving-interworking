import { spawn } from "node:child_process";

// Only a local stdio connection. No model turn, resume, or authentication data.
export class CodexRPC {
  constructor(
    executable,
    { cwd, env = process.env, timeout = 25000, spawnProcess = spawn } = {},
  ) {
    this.timeout = timeout;
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = "";
    this.closed = false;
    this.child = spawnProcess(executable, ["app-server"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.receive(chunk));
    // Do not persist app-server logs: they can contain private local metadata.
    this.child.stderr.resume();
    this.child.stdin.on("error", () =>
      this.fail(Error("Codex 本地接口已关闭")),
    );
    this.child.on("error", () => {
      this.fail(Error("无法启动此 Codex 可执行文件"));
      this.close();
    });
    this.child.on("close", () => {
      this.closed = true;
      this.fail(Error("Codex 本地接口进程已退出"));
    });
  }
  receive(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) {
      this.fail(Error("Codex 单页响应超过 32 MiB，请减小分页"));
      this.close();
      return;
    }
    let end;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(Error("Codex 本地接口返回无效 JSON"));
        this.close();
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = Error(
          String(message.error.message || "Codex 接口失败").slice(0, 500),
        );
        error.code = message.error.code;
        pending.reject(error);
      } else if (Object.hasOwn(message, "result"))
        pending.resolve(message.result);
      else pending.reject(Error("Codex 响应缺少 result"));
    }
  }
  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  request(method, params = {}) {
    if (this.closed) return Promise.reject(Error("Codex 本地连接已关闭"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`Codex ${method} 超时`));
        this.close();
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: { name: "spire-save-bridge", version: "0.1.3" },
    });
    this.child.stdin.write(
      JSON.stringify({ method: "initialized", params: {} }) + "\n",
    );
    return result;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.fail(Error("Codex 本地读取已结束"));
    this.child.stdin.end();
    this.child.kill();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
    timer.unref();
    this.child.once("close", () => clearTimeout(timer));
  }
}
