const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
if (process.env.SPIRE_SMOKE === "1")
  app.setPath("userData", path.resolve(".data/smoke"));
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
    ] = await Promise.all([
      import("./quark.mjs"),
      import("./service.mjs"),
      import("./platform.mjs"),
      import("./snapshot.mjs"),
      import("../scripts/cloud-probe.mjs"),
      import("./summary.mjs"),
      import("./environment.mjs"),
    ]);
    const fs = require("node:fs/promises");
    const stateDir = app.isPackaged
      ? app.getPath("userData")
      : path.resolve(".data/desktop");
    await fs.mkdir(stateDir, { recursive: true });
    const notices = [];
    const q = new Quark({
      workDir: path.join(stateDir, "quark"),
      cli: app.isPackaged
        ? path.join(process.resourcesPath, "quark/scripts/quark-drive.cjs")
        : undefined,
      notify: (t) => notices.push(t),
    });
    const service = new Service({ quark: q, stateDir });
    const win = new BrowserWindow({
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
      if (
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame
      )
        return { ok: false, error: "请求来源无效" };
      try {
        const profiles = await discover();
        const source = profiles.find(
          (p) => p.account + "-" + p.profile + "-" + p.layout === args.key,
        );
        const p = source ? { ...source, group: args.group } : null;
        if (
          p &&
          (!["vanilla", "modded"].includes(p.group) ||
            (p.layout === "modded" && p.group !== "modded"))
        )
          throw Error("请选择与实际存档匹配的同步组");
        const need = [
          "upload",
          "versions",
          "download",
          "backup",
          "backups",
          "restore",
        ];
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
        } else if (action === "login") data = await q.login();
        else if (action === "probe")
          data = await service.exclusive(() =>
            probe(q, path.join(stateDir, "probe")),
          );
        else if (action === "versions") {
          data = await service.exclusive(() => service.versions(p));
          const h = heads(data);
          data = data.map((v) => ({ ...v, branches: h.length }));
        } else if (action === "backups") data = await service.backups(p);
        else if (action === "backup") data = await service.backup(p);
        else if (["upload", "download", "restore"].includes(action)) {
          if (args.ready !== true)
            throw Error("请先确认 Steam 云已关闭且两端版本、Mod 环境一致");
          if (
            action !== "upload" &&
            (typeof args.id !== "string" || !/^[a-f0-9-]{36}$/.test(args.id))
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
      }
    });
    await win.loadFile(path.join(__dirname, "../ui/index.html"));
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
      await fs.writeFile(path.join(stateDir, "screenshot.png"), image.toPNG());
      console.log("DESKTOP_SMOKE_OK");
      app.quit();
    }
  });
  app.on("window-all-closed", () => app.quit());
}
