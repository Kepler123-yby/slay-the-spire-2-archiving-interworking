import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
export function parseOutput(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
export function result(events) {
  const all = events.filter((e) => e.type === "result");
  const r = all.at(-1);
  if (!r || r.code !== 0 || r.data?.failCount > 0)
    throw Error(r?.msg || "夸克工具未返回成功结果");
  return r.data || {};
}
export class Quark {
  constructor({
    workDir,
    cli = fileURLToPath(
      new URL("../.runtime/quark/scripts/quark-drive.cjs", import.meta.url),
    ),
    node = process.execPath,
    notify = () => {},
  }) {
    Object.assign(this, { workDir, cli, node, notify });
  }
  async run(args) {
    await fs.mkdir(this.workDir, { recursive: true });
    await fs.access(this.cli).catch(() => {
      throw Error("尚未安装夸克组件，请运行 npm run setup:quark");
    });
    const events = await new Promise((resolve, reject) => {
      const p = spawn(this.node, [this.cli, ...args], {
        cwd: this.workDir,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "",
        overflow = false;
      const timer = setTimeout(() => {
        p.kill();
        reject(Error("夸克操作超时，请重试"));
      }, 180000);
      p.stdout.setEncoding("utf8");
      p.stdout.on("data", (b) => {
        out += b.toString();
        if (out.length > 4 * 1024 * 1024) {
          overflow = true;
          p.kill();
        }
      });
      p.stderr.on("data", () => {});
      p.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        if (overflow) return reject(Error("夸克返回数据超限"));
        const ev = parseOutput(out);
        try {
          result(ev);
          if (code !== 0) throw Error("夸克进程异常退出");
          for (const e of ev) if (e.notice?.text) this.notify(e.notice.text);
          resolve(ev);
        } catch (e) {
          reject(e);
        }
      });
    });
    return events;
  }
  async login() {
    await this.run(["login"]);
    return "夸克授权完成";
  }
  async mkdir(name, parent) {
    const args = ["create-folder", "--dir-path", name];
    if (parent) args.push("--parent-fid", parent);
    const d = result(await this.run(args));
    if (!d.fid) throw Error("夸克未返回文件夹 ID");
    return d.fid;
  }
  async list(fid) {
    const events = await this.run([
      "browse",
      "--parent-fid",
      fid,
      "--all",
      "--task-dir",
      this.workDir,
    ]);
    const d = result(events);
    const a = events.find((e) => e.type === "artifact")?.data;
    const file = d.file_path || a?.file_path;
    if (!file || d.hasMore === true) throw Error("夸克未返回完整目录清单");
    const rel = path.relative(this.workDir, file);
    if (rel.startsWith("..") || path.isAbsolute(rel))
      throw Error("夸克清单路径超出任务目录");
    const st = await fs.stat(file);
    if (st.size > 8 * 1024 * 1024) throw Error("网盘版本目录过大");
    return (await fs.readFile(file, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((x) => JSON.parse(x));
  }
  async put(file, parent) {
    await this.run(["upload", file, "--parent-fid", parent]);
  }
  async get(fid) {
    const dir = path.join(this.workDir, "downloads", randomUUID());
    await fs.mkdir(dir, { recursive: true });
    await this.run(["download", "--fid", fid, "--output-dir", dir]);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile());
    if (files.length !== 1) throw Error("夸克未下载预期的单个文件");
    return path.join(dir, files[0].name);
  }
}
