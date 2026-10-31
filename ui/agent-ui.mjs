export function initAgentUI({ call, onChange }) {
  const $ = (id) => document.getElementById(id);
  let state = { bound: false, busy: false },
    token = null,
    initialized = false;
  const inputs = () => ({
    threadId: $("agentThread").value.trim(),
    proxy: $("agentProxy").value.trim(),
    cwd: $("agentCwd").value.trim(),
  });
  function renderButtons(globalBusy = false) {
    const locked = globalBusy || state.busy;
    for (const id of ["agentPreview", "agentCreate"])
      $(id).disabled = locked || state.bound;
    $("agentLogin").disabled = locked;
    $("agentBind").disabled = locked || state.bound || !token;
    $("contextSync").disabled = locked || !state.bound;
    $("contextPreview").disabled =
      globalBusy || !state.bound || !state.messages;
    $("agentUnbind").disabled = locked || !state.bound;
    $("agentContinue").disabled = locked || !state.bound || !state.lastSuccess;
    $("agentCancel").disabled = !state.busy;
    for (const id of ["agentThread", "agentCwd", "agentProxy"])
      $(id).disabled = locked || state.bound;
  }
  async function refresh() {
    try {
      const result = await window.bridge.call("agentStatus");
      if (!result.ok) {
        $("agentState").textContent = result.error;
        return;
      }
      state = result.data;
      if (!initialized || state.bound) {
        $("agentThread").value = state.threadId;
        $("agentCwd").value = state.cwd;
        $("agentProxy").value = state.proxy;
        initialized = true;
      }
      $("agentState").textContent = [
        state.stage,
        state.bound
          ? `Codex · ${state.model} · ${state.messages} 条公开消息`
          : "Codex 可绑定；其他适配器待验证",
        state.lastSuccess
          ? "最近成功：" + new Date(state.lastSuccess).toLocaleString()
          : "尚无成功同步",
        state.pending ? "有待同步内容" : "",
        state.cloudRevisions ? `云端 ${state.cloudRevisions} 个对话修订` : "",
        state.error,
      ]
        .filter(Boolean)
        .join("\n");
      onChange();
    } catch (error) {
      $("agentState").textContent = error.message;
    }
  }
  for (const id of ["agentThread", "agentCwd", "agentProxy"])
    $(id).addEventListener("input", () => {
      token = null;
      $("agentPreviewText").textContent = "输入已变化，请重新预览。";
      renderButtons();
    });
  $("agentPreview").onclick = async () => {
    const preview = await call("agentPreview", inputs());
    if (preview) {
      token = preview.token;
      $("agentPreviewText").textContent =
        `${preview.messages.length} 条公开消息 · ${preview.reader.pages} 页 · 模型 ${preview.model}\n接口：${preview.reader.cli}\n\n` +
        preview.messages
          .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.text}`)
          .join("\n\n");
    }
    await refresh();
  };
  $("agentBind").onclick = async () => {
    await call("agentBind", { token });
    await refresh();
  };
  $("contextSync").onclick = async () => {
    await call("contextSync");
    await refresh();
  };
  $("contextPreview").onclick = async () => {
    const messages = await call("contextPreview");
    if (messages) {
      $("agentPreviewText").textContent = messages
        .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.text}`)
        .join("\n\n");
      $("agentPreviewText").parentElement.open = true;
    }
  };
  $("agentUnbind").onclick = async () => {
    const result = await call("agentUnbind");
    if (result) {
      token = null;
      initialized = false;
      $("agentPreviewText").textContent = "对话缓存已清理。";
    }
    await refresh();
  };
  $("agentLogin").onclick = async () => {
    await call("agentLogin", inputs());
    await refresh();
  };
  $("agentCreate").onclick = async () => {
    const result = await call("agentCreate", inputs());
    if (result) {
      $("agentThread").value = result.threadId;
      token = null;
    }
    await refresh();
  };
  $("agentContinue").onclick = async () => {
    const result = await call("agentContinue");
    if (result)
      $("agentCommand").textContent =
        "命令已复制，请在本机终端粘贴运行：\n" + result.command;
  };
  $("agentCancel").onclick = async () => {
    await window.bridge.call("agentCancel");
    await refresh();
  };
  refresh();
  const timer = setInterval(refresh, 3000);
  window.addEventListener("beforeunload", () => clearInterval(timer));
  return {
    renderButtons,
    get busy() {
      return state.busy;
    },
    get blocksCloud() {
      return state.busy && !state.background;
    },
    get background() {
      return state.busy && state.background;
    },
  };
}
