import { createHash } from "node:crypto";

export const PROJECT_ID = "spire-save-bridge";
export const CONTEXT_LIMIT = 8 * 1024 * 1024;
export const MESSAGE_LIMIT = 50000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const phases = new Set([
  "commentary",
  "partial_answer",
  "final_answer",
  "final",
]);

export function publicText(value) {
  let text = value.trim();
  if (/^<spire_context_import>/.test(text)) return "";
  // These are transport/instruction envelopes, not user-authored conversation.
  text = text
    .replace(
      /<(environment_context|external_codex_apps_open_page|system|developer|tool_result|tool_response|turn_aborted|permissions instructions)\b[^>]*>[\s\S]*?<\/\1>/gi,
      "",
    )
    .trim();
  if (/^<send_user_message_question_reply>/.test(text)) {
    try {
      const replies = JSON.parse(
        text
          .replace(/^<send_user_message_question_reply>\s*/, "")
          .replace(/\s*<\/send_user_message_question_reply>$/, ""),
      );
      text = replies
        .map((r) => `问题：${r.question}\n回答：${r.answer}`)
        .join("\n\n");
    } catch {
      return "";
    }
  }
  // Exclude, rather than silently retaining, messages carrying authentication material.
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9_.-]{16,})|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|cookie)\s*["']?\s*[:=]\s*["']?[^\s"'\n,}]+/i.test(
      text,
    )
  )
    return "";
  return text;
}

export function messageFromItem(entry, source) {
  const item = entry.item || entry;
  if (typeof item?.id !== "string" || !item.id || item.id.length > 512)
    return null;
  let role, text;
  if (item.type === "userMessage") {
    role = "user";
    text = (item.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("\n");
  } else if (
    item.type === "agentMessage" &&
    (item.phase == null || phases.has(item.phase))
  ) {
    role = "assistant";
    text = item.text || "";
  } else return null;
  text = publicText(text);
  if (!text) return null;
  return {
    id: hash(`${source.agent}\0${source.threadId}\0${item.id}`),
    source: {
      agent: source.agent,
      threadId: source.threadId,
      messageId: item.id,
    },
    role,
    time: Number.isFinite(entry.startedAtMs)
      ? new Date(entry.startedAtMs).toISOString()
      : null,
    text,
  };
}

export function validateDialogue(archive) {
  if (
    archive?.schemaVersion !== 1 ||
    archive.project !== PROJECT_ID ||
    !Array.isArray(archive.messages)
  )
    throw Error("项目对话格式无效");
  if (
    archive.messages.length > MESSAGE_LIMIT ||
    Buffer.byteLength(JSON.stringify(archive)) > CONTEXT_LIMIT
  )
    throw Error("项目对话超过 8 MiB 或 50000 条上限");
  const seen = new Set();
  for (const m of archive.messages) {
    if (
      Object.keys(m).some(
        (k) => !["id", "source", "role", "time", "text"].includes(k),
      ) ||
      Object.keys(m.source || {}).some(
        (k) => !["agent", "threadId", "messageId"].includes(k),
      )
    )
      throw Error("项目对话包含不允许的附加字段");
    if (
      !/^[a-f0-9]{64}$/.test(m.id) ||
      seen.has(m.id) ||
      !["user", "assistant"].includes(m.role) ||
      typeof m.text !== "string" ||
      publicText(m.text) !== m.text ||
      m.source?.agent !== "codex" ||
      typeof m.source.threadId !== "string" ||
      typeof m.source.messageId !== "string" ||
      m.id !== hash(`codex\0${m.source.threadId}\0${m.source.messageId}`)
    )
      throw Error("项目对话消息无效或包含被排除内容");
    seen.add(m.id);
  }
  return archive;
}

export function dialogueHash(archive) {
  validateDialogue(archive);
  return hash(
    JSON.stringify(
      archive.messages
        .map(canonicalMessage)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    ),
  );
}

function canonicalMessage(m) {
  return {
    id: m.id,
    source: {
      agent: m.source.agent,
      threadId: m.source.threadId,
      messageId: m.source.messageId,
    },
    role: m.role,
    time: m.time ?? null,
    text: m.text,
  };
}

export function mergeDialogues(archives) {
  const messages = new Map();
  for (const archive of archives) {
    validateDialogue(archive);
    for (const message of archive.messages) {
      const previous = messages.get(message.id);
      if (
        previous &&
        (previous.text !== message.text ||
          previous.role !== message.role ||
          previous.source.agent !== message.source.agent ||
          previous.source.threadId !== message.source.threadId ||
          previous.source.messageId !== message.source.messageId)
      )
        throw Error("同一来源消息内容冲突，未覆盖已有对话");
      const merged = canonicalMessage(message);
      if (previous?.time)
        merged.time = merged.time
          ? [previous.time, merged.time].sort()[0]
          : previous.time;
      messages.set(message.id, merged);
    }
  }
  return validateDialogue({
    schemaVersion: 1,
    project: PROJECT_ID,
    messages: [...messages.values()],
  });
}
