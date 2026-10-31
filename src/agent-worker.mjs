import fs from "node:fs/promises";
import path from "node:path";
import { Quark } from "./quark.mjs";
import { ContextSync } from "./context-sync.mjs";
import { atomicJSON } from "./snapshot.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export function within(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
export async function assertInputInside(root, file) {
  const stat = await fs.lstat(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !within(await fs.realpath(root), await fs.realpath(file))
  )
    throw Error("任务输入文件越过允许目录或为符号链接");
}
export function validateQuarkTask(task) {
  if (
    !path.isAbsolute(task.root || "") ||
    !Array.isArray(task.args) ||
    task.args.some((s) => typeof s !== "string" || s.length > 4096)
  )
    throw Error("夸克任务无效");
  const a = task.args,
    fid = (s) => typeof s === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(s);
  const valid =
    (a.length === 1 && ["resolve-agent", "login"].includes(a[0])) ||
    (a[0] === "create-folder" &&
      a[1] === "--dir-path" &&
      /^[a-zA-Z0-9_.-]{1,128}$/.test(a[2] || "") &&
      (a.length === 3 ||
        (a.length === 5 && a[3] === "--parent-fid" && fid(a[4])))) ||
    (a.length === 6 &&
      a[0] === "browse" &&
      a[1] === "--parent-fid" &&
      fid(a[2]) &&
      a[3] === "--all" &&
      a[4] === "--task-dir" &&
      within(task.root, a[5])) ||
    (a.length === 4 &&
      a[0] === "upload" &&
      within(task.allowedFilesRoot || task.root, a[1]) &&
      a[2] === "--parent-fid" &&
      fid(a[3])) ||
    (a.length === 5 &&
      a[0] === "download" &&
      a[1] === "--fid" &&
      fid(a[2]) &&
      a[3] === "--output-dir" &&
      within(task.root, a[4]));
  if (!valid) throw Error("不允许的夸克任务或文件路径");
}

async function main() {
  const request = path.resolve(process.argv[2] || "");
  const st = await fs.lstat(request);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 64 * 1024)
    throw Error("工作请求无效");
  const job = JSON.parse(await fs.readFile(request, "utf8"));
  if (
    !/^[a-f0-9-]{36}$/.test(job.nonce) ||
    path.dirname(job.output) !== path.dirname(request) ||
    path.basename(job.output) !== "result.json"
  )
    throw Error("工作结果路径无效");
  let result;
  try {
    const task = job.task;
    if (
      !["check", "quark", "context"].includes(task.kind) ||
      !path.isAbsolute(task.cli || "") ||
      path.basename(task.cli) !== "quark-drive.cjs" ||
      !path.isAbsolute(task.root || "")
    )
      throw Error("工作类型或夸克组件路径无效");
    const q = new Quark({ cli: task.cli, workDir: task.root });
    let data;
    if (task.kind === "check") {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [task.cli, "resolve-agent"],
        { timeout: 10000, maxBuffer: 65536 },
      );
      if (stdout.trim() !== "QK_AGENT_ID=codex")
        throw Error("真实 Agent 任务未通过夸克宿主识别");
      data = { agent: "codex", verified: true };
    } else if (task.kind === "quark") {
      validateQuarkTask(task);
      if (task.args[0] === "upload")
        await assertInputInside(
          task.allowedFilesRoot || task.root,
          task.args[1],
        );
      data = await q.run(task.args);
    } else {
      if (!within(task.contextRoot, task.archive))
        throw Error("对话资料路径无效");
      await assertInputInside(task.contextRoot, task.archive);
      const stat = await fs.stat(task.archive);
      if (stat.size > 8 * 1024 * 1024) throw Error("对话资料超限");
      data = await new ContextSync({ quark: q, root: task.contextRoot }).sync(
        JSON.parse(await fs.readFile(task.archive, "utf8")),
      );
    }
    result = { nonce: job.nonce, ok: true, data };
  } catch (e) {
    result = { nonce: job.nonce, ok: false, error: e.message };
  }
  await atomicJSON(job.output, result);
  await fs.chmod(job.output, 0o600);
  console.log("SPIRE_JOB_DONE:" + job.nonce);
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && path.basename(process.argv[1]) === "agent-worker.mjs")
  main().catch(() => {
    console.error("Agent 工作请求无法读取");
    process.exitCode = 1;
  });
