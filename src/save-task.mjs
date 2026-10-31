import fs from "node:fs/promises";
import path from "node:path";
import { Service } from "./service.mjs";
import { load } from "./snapshot.mjs";

const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

// Fixed save operations run inside the real Agent, with no arbitrary command API.
export async function runSaveTask(task, { quark } = {}) {
  if (!["versions", "upload"].includes(task.operation))
    throw Error("不允许的存档任务");
  if (
    ![task.stateDir, task.allowedStateRoot, task.root].every(
      (p) => typeof p === "string" && path.isAbsolute(p),
    ) ||
    !inside(task.allowedStateRoot, task.stateDir) ||
    !inside(task.stateDir, task.root)
  )
    throw Error("存档任务目录越界");
  const state = await fs.realpath(task.stateDir);
  if (!inside(await fs.realpath(task.allowedStateRoot), state))
    throw Error("存档任务目录越界");
  const cloudRoot = await fs.realpath(task.root).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (cloudRoot && !inside(state, cloudRoot)) throw Error("存档任务目录越界");
  const service = new Service({
    quark,
    stateDir: task.stateDir,
    cache: task.cache,
  });
  service.identity(task.profile);
  if (task.operation === "upload") {
    if (
      typeof task.file !== "string" ||
      !path.isAbsolute(task.file) ||
      !inside(path.join(service.scope(task.profile), "outgoing"), task.file)
    )
      throw Error("上传快照目录越界");
    const stat = await fs.lstat(task.file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !inside(state, await fs.realpath(task.file))
    )
      throw Error("上传快照目录越界");
  }
  const value =
    task.operation === "versions"
      ? await service.versions(task.profile, { fresh: task.fresh === true })
      : // The desktop checks the game and captures the snapshot before dispatch.
        // Publishing that immutable file does not need access to host processes.
        await service.publish(task.profile, task.file, await load(task.file));
  return { value, cache: service.exportCloudCache() };
}
