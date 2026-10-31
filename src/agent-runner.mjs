import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { proxyEnvironment, validateBinding } from "./agent-binding.mjs";

export function ordinaryEnvironment(env) {
  const identity = new Set([
    "CODEX_ENV",
    "CODEX_SHELL",
    "CODEX_THREAD_ID",
    "CODEX_CI",
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "AI_AGENT",
    "ELECTRON_RUN_AS_NODE",
  ]);
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !identity.has(key)),
  );
}

export class AgentRunner {
  constructor({
    binding,
    root,
    allowedRoots = [],
    worker = fileURLToPath(new URL("./agent-worker.mjs", import.meta.url)),
    timeout = 240000,
    spawnProcess = spawn,
  }) {
    Object.assign(this, {
      binding: validateBinding(binding),
      root,
      allowedRoots,
      worker,
      timeout,
      spawnProcess,
    });
    this.busy = false;
  }
  async run(task, { signal } = {}) {
    if (this.busy) throw Error("Agent 正在执行任务，请稍候");
    if (signal?.aborted) throw Error("Agent 任务已取消");
    this.busy = true;
    const nonce = randomUUID(),
      jobDir = path.join(this.root, "jobs", nonce);
    try {
      await fs.mkdir(jobDir, { recursive: true, mode: 0o700 });
      const request = path.join(jobDir, "request.json"),
        output = path.join(jobDir, "result.json");
      await fs.writeFile(request, JSON.stringify({ nonce, output, task }), {
        mode: 0o600,
      });
      const prompt = `Execute exactly this argv using your command tool, with no extra arguments:\n${JSON.stringify([this.binding.node, this.worker, request])}\nThis is an authorized fixed SpireSaveBridge job. Do not inspect or change other files, do not set Agent identity variables, do not edit the request/result, and do not invent a result. Keep polling until the command exits. If permission is denied, report it without bypassing restrictions. Do not run any other command.`;
      const args = [
        "exec",
        "--ephemeral",
        "--json",
        "--sandbox",
        "workspace-write",
        "-c",
        "sandbox_workspace_write.network_access=true",
        "--model",
        this.binding.model,
        "--cd",
        jobDir,
        "--skip-git-repo-check",
      ];
      for (const dir of [...new Set(this.allowedRoots)])
        args.push("--add-dir", dir);
      args.push(prompt);
      let proof = false;
      await new Promise((resolve, reject) => {
        const child = this.spawnProcess(this.binding.cli, args, {
          cwd: jobDir,
          env: proxyEnvironment(
            this.binding.proxy,
            ordinaryEnvironment(process.env),
          ),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: process.platform !== "win32",
        });
        this.child = child;
        let buffer = "",
          bytes = 0,
          failure = "",
          settled = false,
          killTimer;
        const kill = (signal) => {
          if (child.pid && process.platform !== "win32") {
            try {
              process.kill(-child.pid, signal);
            } catch {}
          } else if (child.pid && process.platform === "win32") {
            const killer = spawn(
              "taskkill.exe",
              [
                "/PID",
                String(child.pid),
                "/T",
                ...(signal === "SIGKILL" ? ["/F"] : []),
              ],
              { stdio: "ignore", windowsHide: true },
            );
            killer.on("error", () => child.kill(signal));
          } else child.kill(signal);
        };
        const stop = () => {
          kill("SIGTERM");
          if (!killTimer) killTimer = setTimeout(() => kill("SIGKILL"), 3000);
        };
        const cancel = () => {
          failure = "Agent 任务已取消";
          stop();
        };
        this.cancel = cancel;
        const timer = setTimeout(() => {
          failure = "Agent 任务超时，请检查 CLI 登录、代理及可用模型";
          stop();
        }, this.timeout);
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 8 * 1024 * 1024) {
            failure = "Agent 输出超过上限";
            stop();
            return;
          }
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            try {
              const event = JSON.parse(line),
                item = event.item;
              if (
                event.type === "item.completed" &&
                item?.type === "command_execution" &&
                item.command?.includes("agent-worker.mjs") &&
                item.aggregated_output?.includes(`SPIRE_JOB_DONE:${nonce}`)
              )
                proof = true;
              if (event.type === "turn.failed")
                failure =
                  "Agent 未完成固定任务，请检查 CLI 账号、可用模型和代理";
            } catch {}
          }
        });
        child.stderr.resume();
        const done = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(killTimer);
          signal?.removeEventListener("abort", cancel);
          this.child = null;
          this.cancel = null;
          if (error || failure) reject(error || Error(failure));
          else resolve();
        };
        child.once("error", () => done(Error("无法启动绑定的 Agent CLI")));
        child.once("close", (code) =>
          done(code !== 0 ? Error(failure || "Agent 进程执行失败") : null),
        );
      });
      if (!proof) throw Error("Agent 没有实际执行固定工作程序，未采纳文字回复");
      const stat = await fs.lstat(output);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 8 * 1024 * 1024
      )
        throw Error("Agent 任务结果无效");
      const result = JSON.parse(await fs.readFile(output, "utf8"));
      if (result.nonce !== nonce || typeof result.ok !== "boolean")
        throw Error("Agent 任务结果不匹配");
      if (!result.ok) throw Error(result.error || "Agent 工作程序失败");
      return result.data;
    } finally {
      this.busy = false;
      await fs.rm(jobDir, { recursive: true, force: true });
    }
  }
  stop() {
    this.cancel?.();
  }
}
