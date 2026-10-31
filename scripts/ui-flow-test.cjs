const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
app.setPath("userData", path.resolve(".data/ui-flow-test"));
app.whenReady().then(async () => {
  const calls = [];
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
    if (action === "status")
      return {
        ok: true,
        data: [1, 2].map((n) => ({
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
    for (let n = 0; n < 100; n++) {
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
    console.log(
      "UI_FLOW_OK: 显式选择、无默认覆盖、切换档位失效、只在点击覆盖后提交选定版本；仅合成数据。",
    );
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode || 0);
  }
});
