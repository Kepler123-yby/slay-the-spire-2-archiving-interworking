import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { summarize } from "./summary.mjs";
export const LIMIT = 64 * 1024 * 1024;
export const digest = (x) => createHash("sha256").update(x).digest("hex");
const idPattern = /^[a-f0-9-]{36}$/;
export function safePath(p) {
  if (
    typeof p !== "string" ||
    p.length > 240 ||
    p.includes("\\") ||
    p.includes(":") ||
    p.startsWith("/") ||
    p
      .split("/")
      .some(
        (s) =>
          !s ||
          s === "." ||
          s === ".." ||
          /[\x00-\x1f<>"|?*]/.test(s) ||
          /[. ]$/.test(s) ||
          /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s),
      )
  )
    throw Error("存档包含不安全路径");
  return p;
}
export function managed(p) {
  return (
    !/^prefs\.save(?:\.backup)?$/i.test(p) &&
    (/^[^/]+\.save(?:\.backup)?$/i.test(p) || p.startsWith("history/"))
  );
}
export async function assertDirectory(dir) {
  let at = path.resolve(dir);
  for (let i = 0; i < 4; i++) {
    const st = await fs.lstat(at);
    if (st.isSymbolicLink() || !st.isDirectory())
      throw Error("存档根目录或父目录不能是符号链接");
    const next = path.dirname(at);
    if (next === at) break;
    at = next;
  }
}
export async function readFiles(dir) {
  await assertDirectory(dir);
  const out = [];
  let total = 0;
  async function walk(at, rel = "") {
    const entries = await fs.readdir(at, { withFileTypes: true });
    for (const e of entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const r = rel ? rel + "/" + e.name : e.name;
      safePath(r);
      if (e.isSymbolicLink()) throw Error("存档目录不能包含符号链接");
      if (e.isDirectory()) {
        if (r !== "history" && !r.startsWith("history/"))
          throw Error("尚未识别的存档子目录：" + r);
        await walk(path.join(at, e.name), r);
      } else if (e.isFile()) {
        if (/^prefs\.save(?:\.backup)?$/i.test(r)) continue;
        if (!managed(r)) throw Error("尚未识别的存档文件：" + r);
        const s = await fs.lstat(path.join(at, e.name));
        if (s.size > LIMIT || total + s.size > LIMIT)
          throw Error("存档超过 64 MiB 限制");
        const b = await fs.readFile(path.join(at, e.name));
        total += b.length;
        out.push({
          path: r,
          size: b.length,
          sha256: digest(b),
          data: b.toString("base64"),
        });
      } else throw Error("存档包含特殊文件");
    }
  }
  await walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
export function contentHash(files) {
  return digest(
    JSON.stringify(
      files
        .map(({ path, size, sha256 }) => ({ path, size, sha256 }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ),
  );
}
export function validate(s) {
  if (
    !s ||
    s.format !== 1 ||
    !idPattern.test(s.id) ||
    !/^\d{5,20}$/.test(s.account) ||
    !/^profile[123]$/.test(s.profile) ||
    !["vanilla", "modded"].includes(s.group) ||
    !Array.isArray(s.parents) ||
    s.parents.length > 100 ||
    s.parents.some((p) => !idPattern.test(p)) ||
    !Array.isArray(s.files) ||
    s.files.length > 10000
  )
    throw Error("存档格式或身份无效");
  let total = 0;
  const seen = new Set();
  for (const f of s.files) {
    safePath(f.path);
    const key = f.path.normalize("NFC").toLowerCase();
    if (seen.has(key) || !managed(f.path))
      throw Error("存档路径重复或超出范围");
    seen.add(key);
    if (
      typeof f.data !== "string" ||
      !Number.isSafeInteger(f.size) ||
      f.size < 0 ||
      f.size > LIMIT ||
      f.data.length > Math.ceil(f.size / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        f.data,
      )
    )
      throw Error("存档内容无效");
    total += f.size;
    if (total > LIMIT) throw Error("存档超过 64 MiB 限制");
    const b = Buffer.from(f.data, "base64");
    if (b.length !== f.size || digest(b) !== f.sha256)
      throw Error("存档校验失败");
  }
  if (!s.files.some((f) => f.path === "progress.save"))
    throw Error("缺少 progress.save，拒绝应用空存档");
  if (contentHash(s.files) !== s.contentHash) throw Error("存档清单校验失败");
  return s;
}
export async function load(file) {
  const st = await fs.lstat(file);
  if (!st.isFile() || st.size > LIMIT * 1.5)
    throw Error("快照文件过大或类型无效");
  return validate(JSON.parse(await fs.readFile(file, "utf8")));
}
export async function capture(dir, identity, parents = [], environment = null) {
  const files = await readFiles(dir);
  const again = await readFiles(dir);
  if (contentHash(files) !== contentHash(again))
    throw Error("存档正在变化，请关闭游戏后重试");
  let summary = null;
  try {
    const d = JSON.parse(
      Buffer.from(files.find((f) => f.path === "progress.save").data, "base64"),
    );
    summary = summarize(d, {
      environment,
      modifiedAt: (
        await fs.stat(path.join(dir, "progress.save"))
      ).mtime.toISOString(),
    });
  } catch {}
  return validate({
    summary,
    format: 1,
    id: randomUUID(),
    group: "vanilla",
    ...identity,
    parents,
    createdAt: new Date().toISOString(),
    files,
    contentHash: contentHash(files),
  });
}
export async function atomicJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + "." + randomUUID() + ".tmp";
  const h = await fs.open(tmp, "wx", 0o600);
  try {
    await h.writeFile(JSON.stringify(value));
    await h.sync();
  } finally {
    await h.close();
  }
  await fs.rename(tmp, file);
}
const exists = async (p) => !!(await fs.lstat(p).catch(() => null));
function transaction(dir, id) {
  const parent = path.dirname(dir),
    base = path.basename(dir);
  return {
    journal: path.join(parent, `.${base}.spire-transaction.json`),
    old: path.join(parent, `.${base}.spire-old-${id}`),
    stage: path.join(parent, `.${base}.spire-stage-${id}`),
  };
}
export async function recover(dir) {
  const j = transaction(dir, "").journal;
  if (!(await exists(j))) return false;
  const record = JSON.parse(await fs.readFile(j, "utf8"));
  if (!idPattern.test(record.id)) throw Error("事务记录无效，请保留现场");
  const t = transaction(dir, record.id);
  if (await exists(t.old)) {
    if (await exists(dir))
      await fs.rename(
        dir,
        path.join(
          path.dirname(dir),
          ".spire-recovery-preserved-" + record.id + "-" + randomUUID(),
        ),
      );
    await fs.rename(t.old, dir);
  } else if (!(await exists(dir)))
    throw Error("恢复所需的原始存档缺失，请保留现场");
  await fs.rm(t.stage, { recursive: true, force: true });
  await fs.rm(j);
  return true;
}
export async function apply(dir, s, stateDir, { checkpoint = () => {} } = {}) {
  validate(s);
  await recover(dir);
  const current = await readFiles(dir),
    backup = await capture(
      dir,
      {
        account: s.account,
        profile: s.profile,
        group: s.group,
        device: "local-backup",
      },
      [],
    );
  await atomicJSON(path.join(stateDir, "backups", backup.id + ".json"), backup);
  const t = transaction(dir, randomUUID()),
    id = path.basename(t.old).split("spire-old-")[1];
  try {
    await assertDirectory(dir);
    await fs.cp(dir, t.stage, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
    });
    const stageStat = await fs.lstat(t.stage);
    if (stageStat.isSymbolicLink() || !stageStat.isDirectory())
      throw Error("暂存目录类型无效");
    for (const f of current) await fs.rm(path.join(t.stage, f.path));
    for (const f of s.files) {
      const target = path.join(t.stage, f.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(f.data, "base64"), {
        mode: 0o600,
      });
    }
    if (contentHash(await readFiles(dir)) !== contentHash(current))
      throw Error("本机进度已变化，请重新比较");
    await checkpoint("before-commit");
    await atomicJSON(t.journal, { id });
    await fs.rename(dir, t.old);
    await checkpoint("old-moved");
    await fs.rename(t.stage, dir);
    await checkpoint("new-moved");
    if (contentHash(await readFiles(dir)) !== s.contentHash)
      throw Error("写入后校验失败");
    await fs.rm(t.journal);
    await fs.rm(t.old, { recursive: true }).catch(() => {});
    return backup.id;
  } catch (e) {
    await recover(dir);
    await fs.rm(t.stage, { recursive: true, force: true });
    throw e;
  }
}
