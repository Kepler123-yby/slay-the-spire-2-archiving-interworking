import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { atomicJSON } from "./snapshot.mjs";
import {
  PROJECT_ID,
  CONTEXT_LIMIT,
  validateDialogue,
  mergeDialogues,
  dialogueHash,
} from "./project-dialogue.mjs";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export class ContextSync {
  constructor({ quark, root, cloudRoot = "STS2-SaveSync" }) {
    Object.assign(this, { quark, root, cloudRoot });
  }
  async read(name, fallback = null) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.root, name), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return fallback;
      throw e;
    }
  }
  async downloaded(fid, limit) {
    const file = await this.quark.get(fid),
      stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
      throw Error("云端项目对话文件超限");
    return fs.readFile(file);
  }
  async sync(local) {
    validateDialogue(local);
    const previous = await this.read("merged.json");
    let merged = mergeDialogues([...(previous ? [previous] : []), local]);
    await atomicJSON(path.join(this.root, "merged.json"), merged);
    let fid = await this.quark.mkdir(this.cloudRoot);
    for (const part of ["project-context", PROJECT_ID])
      fid = await this.quark.mkdir(part, fid);
    const items = await this.quark.list(fid);
    if (items.length > 256)
      throw Error(
        "云端对话修订超过 128 份，请整理云端目录后重试；当前接入不能自动删除",
      );
    const revisions = [];
    for (const item of items.filter((x) =>
      /^[a-f0-9-]{36}\.ready\.json$/.test(x.filename),
    )) {
      if (item.size > 64 * 1024) throw Error("云端对话完成标记超限");
      const marker = JSON.parse(await this.downloaded(item.fid, 64 * 1024));
      if (
        marker.format !== "spire-context-1" ||
        marker.project !== PROJECT_ID ||
        !idPattern.test(marker.id) ||
        item.filename !== marker.id + ".ready.json" ||
        !/^[a-f0-9]{64}$/.test(marker.hash) ||
        !Array.isArray(marker.parents) ||
        marker.parents.length > 128 ||
        marker.parents.some((id) => !idPattern.test(id))
      )
        throw Error("云端对话完成标记无效，未覆盖本地对话");
      const payload = items.find(
        (x) => x.filename === marker.id + ".context.json",
      );
      if (!payload || payload.size > CONTEXT_LIMIT)
        throw Error("云端已发布对话缺失或过大");
      const bytes = await this.downloaded(payload.fid, CONTEXT_LIMIT);
      if (digest(bytes) !== marker.hash)
        throw Error("云端对话哈希不匹配，未采用损坏内容");
      const archive = validateDialogue(JSON.parse(bytes));
      merged = mergeDialogues([merged, archive]);
      revisions.push({ ...marker, contentHash: dialogueHash(archive) });
    }
    await atomicJSON(path.join(this.root, "merged.json"), merged);
    const hash = dialogueHash(merged);
    const parents = new Set(revisions.flatMap((r) => r.parents));
    const heads = revisions.filter((r) => !parents.has(r.id));
    let uploaded = false;
    let revision = revisions.find((r) => r.contentHash === hash)?.id || null;
    if (!revision && merged.messages.length) {
      revision = randomUUID();
      const payload = path.join(
        this.root,
        "outgoing",
        revision + ".context.json",
      );
      const ready = path.join(this.root, "outgoing", revision + ".ready.json");
      await atomicJSON(payload, merged);
      const bytes = await fs.readFile(payload),
        payloadHash = digest(bytes);
      await this.quark.put(payload, fid);
      let list = await this.quark.list(fid);
      const remote = list.find((x) => x.filename === path.basename(payload));
      if (
        !remote ||
        digest(await this.downloaded(remote.fid, CONTEXT_LIMIT)) !== payloadHash
      )
        throw Error("项目对话上传回读失败，待同步记录已保留");
      await atomicJSON(ready, {
        format: "spire-context-1",
        project: PROJECT_ID,
        id: revision,
        parents: heads.map((r) => r.id),
        hash: payloadHash,
      });
      await this.quark.put(ready, fid);
      list = await this.quark.list(fid);
      const published = list.find((x) => x.filename === path.basename(ready));
      if (
        !published ||
        digest(await this.downloaded(published.fid, 64 * 1024)) !==
          digest(await fs.readFile(ready))
      )
        throw Error("项目对话发布校验失败，待同步记录已保留");
      uploaded = true;
    }
    const state = {
      hash,
      revision,
      messages: merged.messages.length,
      lastSuccess: new Date().toISOString(),
      uploaded,
      cloudRevisions: revisions.length + Number(uploaded),
    };
    await atomicJSON(path.join(this.root, "sync-state.json"), state);
    return state;
  }
}
