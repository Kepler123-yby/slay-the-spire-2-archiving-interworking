import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { Quark } from "../src/quark.mjs";
import { digest } from "../src/snapshot.mjs";
export async function probe(q, root) {
  const fid = await q.mkdir("STS2-SaveSync-Validation");
  const dir = await q.mkdir("probe-" + randomUUID(), fid);
  const name = "probe-" + randomUUID() + ".txt",
    data = randomBytes(1024).toString("hex");
  const file = path.join(root, name);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(file, data);
  await q.put(file, dir);
  const items = await q.list(dir);
  const item = items.find((x) => x.filename === name);
  if (!item) throw Error("上传后未能枚举测试文件");
  const downloaded = await q.get(item.fid);
  if (digest(await fs.readFile(downloaded)) !== digest(data))
    throw Error("云端回读哈希不一致");
  return {
    passed: true,
    bytes: Buffer.byteLength(data),
    message:
      "夸克真实上传、完整枚举、下载及 SHA-256 校验通过。测试文件保留在 STS2-SaveSync-Validation。",
  };
}
if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const root = path.resolve(".data/cloud-probe");
  const q = new Quark({ workDir: root, notify: console.log });
  try {
    console.log(JSON.stringify(await probe(q, root), null, 2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
