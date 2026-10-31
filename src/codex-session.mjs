import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CodexRPC } from "./codex-rpc.mjs";
import {
  PROJECT_ID,
  MESSAGE_LIMIT,
  messageFromItem,
  validateDialogue,
} from "./project-dialogue.mjs";

export async function codexCandidates({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
} = {}) {
  const bundled =
    platform === "darwin"
      ? [
          "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
          path.join(
            home,
            "Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
          ),
          "/Applications/Codex.app/Contents/Resources/codex",
        ]
      : [];
  const paths = (env.PATH || env.Path || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, platform === "win32" ? "codex.exe" : "codex"));
  const found = [];
  for (const file of [...new Set([...bundled, ...paths])]) {
    try {
      await fs.access(
        file,
        platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
      );
      if ((await fs.stat(file)).isFile()) found.push(file);
    } catch {}
  }
  return found;
}

const unsupported = (error) =>
  error.code === -32601 ||
  /paginated_threads is not supported|method not found|unknown method|unsupported.method/i.test(
    error.message,
  );

// Prefer the desktop's compatible binary, and consume every page without resuming.
export async function readCodexSession({
  threadId,
  cwd,
  candidates,
  signal,
  connect = (cli) => new CodexRPC(cli, { cwd }),
}) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId || ""))
    throw Error("请选择有效的 Codex 会话 ID");
  const expected = await fs.realpath(cwd);
  const choices = candidates || (await codexCandidates());
  if (!choices.length) throw Error("未找到 Codex CLI 或桌面端自带接口");
  const failures = [];
  for (const cli of choices) {
    if (signal?.aborted) throw Error("会话读取已取消");
    let rpc;
    const cancel = () => rpc?.close();
    try {
      rpc = connect(cli);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) throw Error("会话读取已取消");
      await rpc.initialize();
      const { thread } = await rpc.request("thread/read", {
        threadId,
        includeTurns: false,
      });
      if (
        thread?.id !== threadId ||
        typeof thread.cwd !== "string" ||
        (await fs.realpath(thread.cwd)) !== expected
      )
        throw Error("会话与当前项目不匹配，未导出其他项目对话");
      const source = { agent: "codex", threadId };
      const messages = new Map();
      let excluded = 0,
        pages = 0,
        cursor,
        entries = 0;
      const importedTurns = new Set();
      const consume = (entry) => {
        if (
          entry.item?.type === "userMessage" &&
          entry.item.content?.some(
            (b) =>
              b.type === "text" && /^<spire_context_import>/.test(b.text || ""),
          )
        )
          importedTurns.add(entry.turnId);
        if (entry.turnId && importedTurns.has(entry.turnId)) {
          excluded++;
          return;
        }
        const m = messageFromItem(entry, source);
        if (m) {
          const previous = messages.get(m.id);
          if (previous && JSON.stringify(previous) !== JSON.stringify(m))
            throw Error("分页消息内容变化，请重试完整读取");
          messages.set(m.id, m);
          if (messages.size > MESSAGE_LIMIT)
            throw Error("项目对话超过 50000 条上限");
        } else excluded++;
      };
      let mode = "paginated";
      const cursors = new Set();
      try {
        do {
          if (++pages > 2000)
            throw Error("会话分页超过安全上限，未返回不完整导出");
          const page = await rpc.request("thread/items/list", {
            threadId,
            limit: 100,
            sortDirection: "asc",
            ...(cursor ? { cursor } : {}),
          });
          if (!Array.isArray(page?.data) || page.data.length > 100)
            throw Error("会话分页响应无效");
          entries += page.data.length;
          if (entries > 200000) throw Error("会话条目超过安全上限");
          page.data.forEach(consume);
          cursor = page.nextCursor;
          if (
            cursor != null &&
            (typeof cursor !== "string" || !cursor || cursors.has(cursor))
          )
            throw Error("会话分页游标无效或重复");
          if (cursor) cursors.add(cursor);
        } while (cursor);
      } catch (error) {
        if (pages !== 1 || messages.size || !unsupported(error)) throw error;
        mode = "legacy";
        const history = await rpc.request("thread/read", {
          threadId,
          includeTurns: true,
        });
        if (
          history.thread?.id !== threadId ||
          !Array.isArray(history.thread.turns)
        )
          throw Error("旧版会话历史无效");
        for (const turn of history.thread.turns)
          for (const item of turn.items || [])
            consume({ item, turnId: turn.id });
      }
      const archive = validateDialogue({
        schemaVersion: 1,
        project: PROJECT_ID,
        messages: [...messages.values()],
      });
      return {
        archive,
        reader: {
          cli,
          mode,
          pages,
          excluded,
          completeThroughRead: true,
          capturedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      if (signal?.aborted) throw Error("会话读取已取消");
      failures.push({ cli, message: error.message, code: error.code });
      if (!unsupported(error)) throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      rpc?.close();
    }
  }
  const error = Error(
    "已安装的 Codex 接口不支持此会话格式，请选择桌面端自带的兼容版本",
  );
  error.failures = failures;
  throw error;
}
