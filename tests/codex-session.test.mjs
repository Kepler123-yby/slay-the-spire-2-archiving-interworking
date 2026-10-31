import test from "node:test";
import assert from "node:assert/strict";
import { readCodexSession, codexCandidates } from "../src/codex-session.mjs";
import {
  messageFromItem,
  PROJECT_ID,
  mergeDialogues,
  dialogueHash,
} from "../src/project-dialogue.mjs";
const threadId = "01234567-1234-1234-1234-123456789abc";
const source = { agent: "codex", threadId };
const user = (id, text) => ({
  item: { type: "userMessage", id, content: [{ type: "text", text }] },
});
const metadata = { thread: { id: threadId, cwd: process.cwd() } };
const unsupported = () =>
  Object.assign(Error("paginated_threads is not supported yet"), {
    code: -32601,
  });

test("旧 CLI 不支持分页时切换兼容桌面接口并读取所有页，关闭每个连接", async () => {
  const calls = [],
    closed = [];
  const result = await readCodexSession({
    threadId,
    cwd: process.cwd(),
    candidates: ["old", "desktop"],
    connect(cli) {
      return {
        async initialize() {},
        close() {
          closed.push(cli);
        },
        async request(method, args) {
          calls.push({ cli, method, args });
          if (cli === "old") throw unsupported();
          if (method === "thread/read") return metadata;
          if (!args.cursor)
            return {
              data: [
                user("one", "第一条"),
                {
                  item: { type: "reasoning", id: "private", text: "不可导出" },
                },
              ],
              nextCursor: "next",
            };
          return {
            data: [
              {
                item: {
                  type: "agentMessage",
                  id: "two",
                  phase: "final_answer",
                  text: "第二条",
                },
              },
            ],
            nextCursor: null,
          };
        },
      };
    },
  });
  assert.deepEqual(
    result.archive.messages.map((m) => m.text),
    ["第一条", "第二条"],
  );
  assert.equal(result.reader.mode, "paginated");
  assert.equal(result.reader.pages, 2);
  assert.equal(result.reader.excluded, 1);
  assert.deepEqual(closed, ["old", "desktop"]);
  assert.equal(calls.find((c) => c.args.cursor)?.args.cursor, "next");
  assert(calls.every((c) => !/resume|turn\/start/.test(c.method)));
});

test("旧格式回退全历史，但不会把开发者消息或工具输出导出", async () => {
  const result = await readCodexSession({
    threadId,
    cwd: process.cwd(),
    candidates: ["old"],
    connect() {
      return {
        async initialize() {},
        close() {},
        async request(method, args) {
          if (method === "thread/items/list") throw unsupported();
          if (!args.includeTurns) return metadata;
          return {
            thread: {
              ...metadata.thread,
              turns: [
                {
                  items: [
                    user("legacy", "旧记录").item,
                    {
                      type: "commandExecution",
                      id: "tool",
                      aggregatedOutput: "secret",
                    },
                  ],
                },
              ],
            },
          };
        },
      };
    },
  });
  assert.equal(result.reader.mode, "legacy");
  assert.deepEqual(
    result.archive.messages.map((m) => m.text),
    ["旧记录"],
  );
});

test("重复游标、丢失页及项目不匹配均失败，不交付部分成功", async () => {
  for (const failure of ["cursor", "page", "project"]) {
    let pages = 0,
      closed = false;
    await assert.rejects(
      readCodexSession({
        threadId,
        cwd: process.cwd(),
        candidates: ["fake"],
        connect() {
          return {
            async initialize() {},
            close() {
              closed = true;
            },
            async request(method) {
              if (method === "thread/read")
                return failure === "project"
                  ? { thread: { ...metadata.thread, cwd: "/tmp" } }
                  : metadata;
              if (++pages > 1 && failure === "page") throw Error("分页断开");
              return { data: [user("message", "公开")], nextCursor: "same" };
            },
          };
        },
      }),
      /游标|断开|不匹配/,
    );
    assert.equal(closed, true);
  }
});

test("白名单过滤公开内容、问答回执、环境及认证材料", () => {
  assert.equal(
    messageFromItem(
      user(
        "environment",
        "<environment_context>private paths</environment_context>",
      ),
      source,
    ),
    null,
  );
  assert.equal(
    messageFromItem(
      user("secret", 'access_token="abcdefghijklmnopqrstuvwxyz"'),
      source,
    ),
    null,
  );
  assert.equal(
    messageFromItem(
      {
        item: {
          type: "agentMessage",
          id: "analysis",
          phase: "analysis",
          text: "内部推理",
        },
      },
      source,
    ),
    null,
  );
  const reply =
    "<send_user_message_question_reply>" +
    JSON.stringify([
      { question: "范围？", answer: "项目对话", questionItemId: "private" },
    ]) +
    "</send_user_message_question_reply>";
  assert.equal(
    messageFromItem(user("reply", reply), source).text,
    "问题：范围？\n回答：项目对话",
  );
  assert.equal(
    messageFromItem(
      user(
        "mixed",
        '真正的问题<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>',
      ),
      source,
    ).text,
    "真正的问题",
  );
});

test("同源去重和分支合并稳定，冲突与过大内容不覆盖", () => {
  const a = {
    schemaVersion: 1,
    project: PROJECT_ID,
    messages: [messageFromItem(user("a", "A"), source)],
  };
  const b = { ...a, messages: [messageFromItem(user("b", "B"), source)] };
  assert.equal(mergeDialogues([a, a]).messages.length, 1);
  assert.equal(
    dialogueHash(mergeDialogues([a, b])),
    dialogueHash(mergeDialogues([b, a])),
  );
  assert.throws(
    () =>
      mergeDialogues([
        a,
        { ...a, messages: [{ ...a.messages[0], text: "被改写" }] },
      ]),
    /冲突/,
  );
  assert.throws(
    () =>
      mergeDialogues([
        {
          ...a,
          messages: [{ ...a.messages[0], text: "a".repeat(8 * 1024 * 1024) }],
        },
      ]),
    /上限/,
  );
});

test("可执行文件探测不执行 PATH 内容", async () => {
  assert.deepEqual(
    await codexCandidates({
      platform: "linux",
      env: { PATH: "/missing/codex-reader" },
    }),
    [],
  );
});
