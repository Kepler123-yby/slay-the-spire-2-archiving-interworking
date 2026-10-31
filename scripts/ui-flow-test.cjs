const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
app.setPath("userData", path.resolve(".data/ui-flow-test"));
app.whenReady().then(async () => {
  const calls = [];
  let backupRecords = [];
  let agentState = {
    bound: false,
    busy: false,
    stage: "未绑定",
    threadId: "01234567-1234-1234-1234-123456789abc",
    cwd: "/test/project",
    proxy: "",
    model: "test-model",
    messages: 0,
  };
  let rejectBinding = true;
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  const summary = {
    version: 2,
    characters: [
      {
        id: "CHARACTER.TEST",
        name: "示例角色",
        wins: 2,
        losses: 1,
        ascension: 3,
      },
    ],
    wins: 2,
    losses: 1,
    playtimeSeconds: 3600,
    environment: null,
  };
  ipcMain.handle("bridge", async (_event, action, args) => {
    calls.push({ action, ...args });
    if (action === "agentStatus") return { ok: true, data: agentState };
    if (action === "agentPreview")
      return {
        ok: true,
        data: {
          token: "preview-token",
          messages: [
            { role: "user", text: "公开对话 <script>不执行</script>" },
          ],
          reader: { pages: 1, cli: "/test/codex" },
          model: "test-model",
        },
      };
    if (action === "agentBind") {
      if (rejectBinding)
        return { ok: false, error: "测试：真实入口未通过，不能绑定" };
      agentState = {
        ...agentState,
        bound: true,
        stage: "项目对话已同步",
        messages: 1,
        lastSuccess: "2026-10-31T00:00:00Z",
      };
      return { ok: true, data: { messages: 1 } };
    }
    if (action === "agentUnbind") {
      agentState = {
        ...agentState,
        bound: false,
        stage: "未绑定",
        lastSuccess: null,
      };
      return { ok: true, data: "已解除本机绑定" };
    }
    if (action === "contextSync") {
      agentState = {
        ...agentState,
        pending: true,
        error: "测试网络失败",
        stage: "云端未就绪",
      };
      return { ok: false, error: "测试网络失败" };
    }
    if (action === "status")
      return {
        ok: true,
        data: [1, 2].map((n) => ({
          account: "76561198000000000",
          key: "test-profile" + n,
          profile: "profile" + n,
          layout: "shared",
          files: 1,
          summary,
        })),
      };
    if (action === "versions")
      return {
        ok: true,
        data: ids.map((id, n) => ({
          id,
          device: "测试设备" + n,
          createdAt: "2026-01-01T00:00:00Z",
          summary,
        })),
      };
    if (action === "backups")
      return { ok: true, data: { limit: 2, items: backupRecords } };
    if (action === "deleteBackup") {
      backupRecords = backupRecords.filter((b) => b.key !== args.id);
      return { ok: true, data: "已删除本机备份" };
    }
    if (action === "download")
      return { ok: true, data: "已下载并覆盖当前存档；测试完成" };
    return { ok: false, error: "测试未允许的动作" };
  });
  const win = new BrowserWindow({
    show: false,
    width: 1080,
    height: 780,
    webPreferences: {
      preload: path.resolve("src/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  async function waitFor(code) {
    for (let n = 0; n < 160; n++) {
      if (await evaluate(code)) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw Error("UI等待超时：" + code);
  }
  try {
    await win.loadFile(path.resolve("ui/index.html"));
    await waitFor("document.getElementById('profiles').options.length===2");
    assert.equal(
      await evaluate("document.getElementById('overwrite').disabled"),
      true,
    );
    await evaluate("document.getElementById('refresh').click()");
    await waitFor("document.getElementById('cloudVersion').options.length===3");
    assert.equal(
      await evaluate("document.getElementById('cloudVersion').value"),
      "",
    );
    assert.equal(calls.filter((c) => c.action === "download").length, 0);
    await evaluate(
      `document.getElementById('cloudVersion').value='${ids[1]}';document.getElementById('cloudVersion').dispatchEvent(new Event('change'));`,
    );
    assert.equal(
      await evaluate("document.getElementById('overwrite').disabled"),
      false,
    );
    assert.equal(calls.filter((c) => c.action === "download").length, 0);
    assert.ok(
      await evaluate(
        "document.getElementById('selectedVersion').textContent.includes('22222222')",
      ),
    );
    await evaluate(
      "document.getElementById('cloudVersion').scrollIntoView({block:'center'})",
    );
    await fs.mkdir(path.resolve(".data"), { recursive: true });
    await fs.writeFile(
      path.resolve(".data/ui-flow-preview.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    await evaluate(
      "document.getElementById('profiles').value='test-profile2';document.getElementById('profiles').dispatchEvent(new Event('change'))",
    );
    assert.equal(
      await evaluate("document.getElementById('overwrite').disabled"),
      true,
    );
    await evaluate("document.getElementById('refresh').click()");
    await waitFor("document.getElementById('cloudVersion').options.length===3");
    await evaluate(
      `document.getElementById('cloudVersion').value='${ids[1]}';document.getElementById('cloudVersion').dispatchEvent(new Event('change'));document.getElementById('ready').checked=true;document.getElementById('overwrite').click()`,
    );
    await waitFor(
      "document.getElementById('status').textContent.includes('测试完成')",
    );
    const downloads = calls.filter((c) => c.action === "download");
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].id, ids[1]);
    assert.equal(downloads[0].key, "test-profile2");
    assert.equal(downloads[0].ready, true);
    assert.equal(
      await evaluate("document.getElementById('overwrite').disabled"),
      true,
    );
    backupRecords = [1, 2].map((n) => ({
      key: String(n).repeat(64),
      id: ids[n - 1],
      account: "76561198000000000",
      profile: "profile" + n,
      group: "modded",
      createdAt: "2026-01-01T00:00:00Z",
      summary,
      corrupt: false,
    }));
    await evaluate("document.getElementById('listBackups').click()");
    await waitFor(
      "document.querySelectorAll('[data-backup-remove]').length===2",
    );
    assert.equal(
      await evaluate("document.getElementById('backup').disabled"),
      true,
    );
    assert.equal(
      await evaluate(
        "[...document.querySelectorAll('[data-restore-key]')].every(b=>b.disabled)",
      ),
      true,
    );
    await evaluate("document.querySelector('[data-backup-remove]').click()");
    await waitFor(
      "document.getElementById('backupCapacity').textContent.includes('1 / 2')",
    );
    assert.equal(
      await evaluate("document.getElementById('backup').disabled"),
      false,
    );
    assert.equal(calls.filter((c) => c.action === "deleteBackup").length, 1);
    assert.equal(
      await evaluate("document.querySelector('[data-restore-key]').disabled"),
      false,
    );
    await evaluate(
      "document.getElementById('backups').closest('details').open=true;document.getElementById('backups').scrollIntoView({block:'center'})",
    );
    await fs.writeFile(
      path.resolve(".data/ui-backup-management-preview.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    await evaluate(
      "document.getElementById('agentPanel').open=true;document.getElementById('agentPreview').click()",
    );
    await waitFor("!document.getElementById('agentBind').disabled");
    assert.equal(
      await evaluate(
        "document.querySelectorAll('#agentPreviewText script').length",
      ),
      0,
    );
    await evaluate("document.getElementById('agentBind').click()");
    await waitFor(
      "document.getElementById('status').textContent.includes('不能绑定')",
    );
    assert.equal(agentState.bound, false);
    assert.equal(
      await evaluate("document.getElementById('backup').disabled"),
      false,
    );
    rejectBinding = false;
    await evaluate("document.getElementById('agentBind').click()");
    await waitFor("!document.getElementById('contextSync').disabled");
    assert.equal(
      await evaluate("document.getElementById('agentThread').disabled"),
      true,
    );
    await evaluate("document.getElementById('contextSync').click()");
    await waitFor(
      "document.getElementById('agentState').textContent.includes('测试网络失败')",
    );
    assert.equal(
      await evaluate("document.getElementById('backup').disabled"),
      false,
    );
    assert.equal(agentState.pending, true);
    await evaluate(
      "document.getElementById('agentPanel').scrollIntoView({block:'center'})",
    );
    await fs.writeFile(
      path.resolve(".data/ui-agent-binding-preview.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    await evaluate("document.getElementById('agentUnbind').click()");
    await waitFor("!document.getElementById('agentPreview').disabled");
    assert.equal(agentState.bound, false);
    console.log(
      "UI_FLOW_OK: 显式选择、备份限额、Agent 预览、失败不绑定、同步失败保留待办和离线功能、解除绑定；仅合成数据。",
    );
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode || 0);
  }
});
