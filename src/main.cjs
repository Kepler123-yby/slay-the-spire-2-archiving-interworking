const { app, BrowserWindow, ipcMain, dialog, clipboard } = require("electron");
const path = require("node:path");
if (process.env.SPIRE_SMOKE === "1") app.disableHardwareAcceleration();
const userDataPath =
  process.env.SPIRE_SMOKE === "1"
    ? path.resolve(".data/smoke")
    : path.join(app.getPath("appData"), "SpireSaveBridge");
require("node:fs").mkdirSync(userDataPath, { recursive: true });
app.setPath("userData", userDataPath);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    const [
      { Quark },
      { Service, heads },
      { discover, assertGameClosed },
      { readFiles, contentHash, recover },
      { probe },
      { summarize },
      { readEnvironment },
      { Backups },
      { AgentManager },
    ] = await Promise.all([
      import("./quark.mjs"),
      import("./service.mjs"),
      import("./platform.mjs"),
      import("./snapshot.mjs"),
      import("../scripts/cloud-probe.mjs"),
      import("./summary.mjs"),
      import("./environment.mjs"),
      import("./backups.mjs"),
      import("./agent-manager.mjs"),
    ]);
    const fs = require("node:fs/promises");
    const stateDir = app.isPackaged
      ? app.getPath("userData")
      : path.resolve(".data/desktop");
    await fs.mkdir(stateDir, { recursive: true });
    let quarkCLI;
    if (app.isPackaged) {
      const scripts = path.join(userDataPath, "quark-runtime", "scripts");
      await fs.mkdir(scripts, { recursive: true });
      for (const name of ["quark-drive.cjs", "hash-worker.cjs"])
        await fs.copyFile(
          path.join(process.resourcesPath, "quark", "scripts", name),
          path.join(scripts, name),
        );
      quarkCLI = path.join(scripts, "quark-drive.cjs");
    }
    const notices = [];
    const q = new Quark({
      workDir: path.join(stateDir, "quark"),
      cli: quarkCLI,
      notify: (t) => notices.push(t),
    });
    const backupStore = new Backups({
      root:
        process.env.SPIRE_SMOKE === "1"
          ? path.join(stateDir, "local-backups")
          : path.join(
              app.getPath("appData"),
              "SpireSaveBridge",
              "local-backups",
            ),
      legacyRoots:
        process.env.SPIRE_SMOKE === "1"
          ? [stateDir]
          : [
              stateDir,
              path.resolve(".data/desktop"),
              path.join(app.getPath("appData"), "spire-save-bridge"),
            ],
    });
    const service = new Service({ quark: q, stateDir, backupStore });
    const agents = new AgentManager({
      root: path.join(userDataPath, "agent"),
      projectDir: process.cwd(),
      quark: q,
      allowedRoots: [stateDir, userDataPath],
      worker: app.isPackaged
        ? path.join(process.resourcesPath, "agent-runtime", "src", "agent-worker.mjs")
        : undefined,
      continueScript: app.isPackaged
        ? path.join(process.resourcesPath, "agent-runtime", "scripts", "continue-bound-agent.mjs")
        : undefined,
    });
    await agents.init();
    const win = new BrowserWindow({
      show: process.env.SPIRE_SMOKE !== "1",
      width: 1080,
      height: 780,
      minWidth: 840,
      minHeight: 640,
      backgroundColor: "#E7EFF4",
      title: "尖塔存档桥",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    ipcMain.handle("bridge", async (event, action, args = {}) => {
      let releasePriority;
      if (
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame
      )
        return { ok: false, error: "请求来源无效" };
      try {
        if (
          [
            "agentStatus",
            "agentPreview",
            "agentBind",
            "agentUnbind",
            "agentContinue",
            "agentLogin",
            "agentCreate",
            "agentCancel",
            "contextPreview",
            "contextSync",
          ].includes(action)
        ) {
          if (
            ![
              "agentStatus",
              "agentContinue",
              "agentCancel",
              "contextPreview",
            ].includes(action) &&
            service.busy
          )
            throw Error("请等待存档任务完成");
          let data;
          if (action === "agentStatus") data = await agents.status();
          else if (action === "contextPreview")
            data = await agents.restoredPreview();
          else if (action === "agentPreview")
            data = await agents.preview({
              threadId: args.threadId,
              proxy: args.proxy || "",
              cwd: args.cwd || process.cwd(),
            });
          else if (action === "agentLogin")
            data = await agents.login({
              proxy: args.proxy || "",
              cwd: args.cwd || process.cwd(),
            });
          else if (action === "agentCreate")
            data = await agents.createSession({
              proxy: args.proxy || "",
              cwd: args.cwd || process.cwd(),
            });
          else if (action === "agentBind") {
            const answer = await dialog.showMessageBox(win, {
              type: "question",
              buttons: ["取消", "绑定并同步项目对话"],
              defaultId: 0,
              cancelId: 0,
              message: "绑定本机 Agent 并上传预览中的项目对话？",
              detail:
                "仅同步所选会话的公开对话。后续启动会自动调用真实 Agent，可能消耗模型额度。云端暂时保留多个修订，不会覆盖游戏存档。每台设备仍需安装并登录 Agent。",
            });
            if (answer.response !== 1) throw Error("操作已取消");
            data = await agents.bind(args.token);
          } else if (action === "agentUnbind") {
            const answer = await dialog.showMessageBox(win, {
              type: "warning",
              buttons: ["取消", "解除绑定"],
              defaultId: 0,
              cancelId: 0,
              message: "解除本机绑定并删除工具内的对话缓存？",
              detail: "不会删除 Agent 原会话、游戏存档或云端对话。",
            });
            if (answer.response !== 1) throw Error("操作已取消");
            await agents.unbind();
            data = "已解除本机绑定";
          } else if (action === "agentContinue") {
            data = { command: agents.continueCommand() };
            clipboard.writeText(data.command);
          } else if (action === "agentCancel") {
            agents.stop();
            data = "已请求取消后台任务；待同步记录保留";
          } else data = await agents.sync();
          return { ok: true, data };
        }
        if (["login", "probe", "versions", "upload", "download"].includes(action))
          releasePriority = await agents.prioritizeSave();
        const profiles = await discover();
        const source = profiles.find(
          (p) => p.account + "-" + p.profile + "-" + p.layout === args.key,
        );
        const p = source ? { ...source, group: args.group } : null;
        if (
          p &&
          ["upload", "versions", "download", "backup", "restore"].includes(
            action,
          ) &&
          (!["vanilla", "modded"].includes(p.group) ||
            (p.layout === "modded" && p.group !== "modded"))
        )
          throw Error("请选择与实际存档匹配的同步组");
        const need = ["upload", "versions", "download", "backup", "restore"];
        if (need.includes(action) && !p) throw Error("请选择有效的本机档位");
        let data;
        if (action === "status") {
          data = [];
          const environment = await readEnvironment();
          for (const source of profiles) {
            const p = {
              ...source,
              group: args.group === "modded" ? "modded" : "vanilla",
            };
            if (p.pending) {
              await assertGameClosed();
              await recover(p.dir);
            }
            const files = await readFiles(p.dir);
            const progress = JSON.parse(
              Buffer.from(
                files.find((f) => f.path === "progress.save").data,
                "base64",
              ),
            );
            data.push({
              key: p.account + "-" + p.profile + "-" + p.layout,
              layout: p.layout,
              profile: p.profile,
              account: p.account,
              files: files.length,
              hash: contentHash(files),
              summary: summarize(progress, {
                environment,
                modifiedAt: (
                  await fs.stat(path.join(p.dir, "progress.save"))
                ).mtime.toISOString(),
              }),
            });
          }
        } else if (action === "login") {
          service.clearCloudCache();
          data = await q.login();
        }
        else if (action === "probe")
          data = await service.exclusive(() =>
            probe(q, path.join(stateDir, "probe")),
          );
        else if (action === "versions") {
          data = await service.exclusive(() => service.versions(p));
          const h = heads(data);
          data = data.map((v) => ({ ...v, branches: h.length }));
        } else if (action === "backups") data = await service.backupInfo();
        else if (action === "deleteBackup") {
          const info = await service.backupInfo();
          const selected = info.items.find((b) => b.key === args.id);
          if (!selected) throw Error("请选择有效的本地备份");
          const confirmation = await dialog.showMessageBox(win, {
            type: "warning",
            buttons: ["取消", "删除这份本地备份"],
            defaultId: 0,
            cancelId: 0,
            message: "删除所选本地备份？",
            detail: `备份 ID：${selected.id}\nSteam 账号：${selected.account || "未知"}\n档位：${selected.profile || "未知"} / ${selected.group || "未知"}\n此操作只删除本机备份，不修改游戏当前存档或夸克文件。删除后无法在工具中恢复这份备份。`,
          });
          if (confirmation.response !== 1) throw Error("操作已取消");
          data = await service.deleteBackup(selected.key, true);
        } else if (action === "backup") data = await service.backup(p);
        else if (["upload", "download", "restore"].includes(action)) {
          if (args.ready !== true)
            throw Error("请先确认 Steam 云已关闭且两端版本、Mod 环境一致");
          if (
            action !== "upload" &&
            (typeof args.id !== "string" ||
              !/^(?:[a-f0-9-]{36}|[a-f0-9]{64})$/.test(args.id))
          )
            throw Error("请先选择有效的云端版本或本地备份");
          const result = await dialog.showMessageBox(win, {
            type: "warning",
            buttons: ["取消", action === "download" ? "下载并覆盖" : "继续"],
            defaultId: 0,
            cancelId: 0,
            message:
              action === "upload"
                ? "上传当前本机进度？"
                : action === "download"
                  ? "用所选云端版本覆盖当前存档？"
                  : "用本地备份恢复当前存档？",
            detail:
              action === "upload"
                ? "上传会创建独立的夸克云端版本，不替换本机进度。"
                : `目标档位：${p.profile}（${p.group === "modded" ? "Mod 进度" : "原版进度"}）\n目标目录：${p.dir}\n所选版本/备份：${args.id}\n\n先保存本地备份，再替换当前档位；这份覆盖前的备份不会自动上传夸克。`,
          });
          if (result.response !== 1) throw Error("操作已取消");
          data =
            action === "upload"
              ? await service.upload(p)
              : action === "download"
                ? await service.download(p, args.id, true)
                : await service.restore(p, args.id, true);
        } else throw Error("未知操作");
        return { ok: true, data, notices: notices.splice(0) };
      } catch (e) {
        return { ok: false, error: e.message, notices: notices.splice(0) };
      } finally {
        releasePriority?.();
      }
    });
    await win.loadFile(path.join(__dirname, "../ui/index.html"));
    if (process.env.SPIRE_SMOKE !== "1") {
      const startupSync = agents.binding
        ? agents.sync({ background: true })
        : Promise.resolve(null);
      startupSync.catch(() => {});
      const timer = setInterval(() => {
        if (
          agents.binding &&
          !agents.busy &&
          !agents.runner?.busy &&
          !service.busy
        )
          agents.sync({ onlyChanged: true, background: true }).catch(() => {});
      }, 60000);
      app.on("before-quit", () => {
        clearInterval(timer);
        agents.stop();
      });
      if (process.env.SPIRE_PRIORITY_SMOKE === "1") {
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          ready = await win.webContents.executeJavaScript(
            "document.getElementById('profiles').options.length > 0 && !document.getElementById('upload').disabled && document.getElementById('cloudTaskHint').textContent.includes('优先')",
          );
          if (ready) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!ready) throw Error("后台对话同步期间上传按钮未就绪");
        console.log("BACKGROUND_UPLOAD_AVAILABLE=true");
        const refreshed = await win.webContents.executeJavaScript(
          "document.getElementById('refresh').onclick()",
        );
        if (refreshed !== true || agents.foregroundRequests !== 0)
          throw Error("手动刷新未优先完成或任务占用未释放");
        console.log("CLOUD_PRIORITY_SMOKE_OK");
        app.quit();
      }
      if (process.env.SPIRE_AGENT_SMOKE === "1") {
        try {
          const result = await startupSync;
          if (!result || !agents.binding || !result.lastSuccess)
            throw Error("未配置或未完成真实绑定启动同步");
          console.log(
            "AGENT_STARTUP_OK: " +
              JSON.stringify({
                messages: result.messages,
                uploaded: result.uploaded,
                cloudRevisions: result.cloudRevisions,
              }),
          );
          app.quit();
        } catch (error) {
          console.error("AGENT_STARTUP_FAILED: " + error.message);
          app.exit(1);
        }
      }
    }
    if (process.env.SPIRE_SMOKE === "1") {
      await new Promise((r) => setTimeout(r, 1200));
      const disabled = await win.webContents.executeJavaScript(
        "document.getElementById('upload').disabled",
      );
      if (disabled) throw Error("空闲时上传按钮不应按平台锁定");
      console.log("UPLOAD_AVAILABLE=true");
      const overview = await win.webContents.executeJavaScript(
        "({ rows: document.querySelectorAll('#overview tbody tr').length, text: document.getElementById('local').textContent })",
      );
      if (!overview.rows || !overview.text.includes("Mod"))
        throw Error("角色战绩或 Mod 摘要未显示");
      console.log("PROFILE_SUMMARY_OK: " + overview.rows + " characters");
      if (process.env.SPIRE_CLOUD_SMOKE === "1") {
        const r = await win.webContents.executeJavaScript(
          "window.bridge.call('probe')",
        );
        if (!r.ok || !r.data?.passed) throw Error(r.error || "桌面云探针失败");
        console.log("DESKTOP_CLOUD_PROBE_OK");
      }
      const image = await win.webContents.capturePage();
      if (image.isEmpty()) throw Error("桌面截图为空");
      await fs.writeFile(path.join(stateDir, "screenshot.png"), image.toPNG());
      console.log("DESKTOP_SMOKE_OK");
      app.quit();
    }
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
  app.on("window-all-closed", () => app.quit());
}
