import { VersionSelection } from "./version-selection.mjs";
import { metrics, characterTable, cloudSummary } from "./summary-view.mjs";
import { initAgentUI } from "./agent-ui.mjs";
const $ = (id) => document.getElementById(id);
let busy = false,
  profiles = [];
let backupItems = [],
  backupLimit = 2,
  backupCount = null;
const selection = new VersionSelection();
let agentUI;
let currentAction = "";
const scope = () => key() + "|" + $("group").value;
function status(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
  if (error) $("status").scrollIntoView({ block: "nearest" });
}
function key() {
  return $("profiles").value;
}
function buttons() {
  document
    .querySelectorAll("button,select")
    .forEach((b) => (b.disabled = busy));
  const full = backupCount === null || backupCount >= backupLimit;
  $("backup").disabled = busy || full || !profiles.find((p) => p.key === key());
  document.querySelectorAll("[data-restore-key]").forEach((b) => {
    const record = backupItems.find((x) => x.key === b.dataset.restoreKey);
    const p = profiles.find((x) => x.key === key());
    b.disabled =
      busy ||
      full ||
      !record ||
      record.corrupt ||
      !p ||
      record.account !== p.account ||
      record.profile !== p.profile ||
      record.group !== $("group").value;
  });
  $("upload").disabled =
    busy || agentUI?.blocksCloud || !profiles.find((p) => p.key === key());
  for (const id of ["refresh", "login", "probe"])
    $(id).disabled = busy || agentUI?.blocksCloud;
  $("cloudVersion").disabled = busy || !selection.versions.length;
  $("overwrite").disabled =
    busy || agentUI?.blocksCloud || full || !selection.selected(scope());
  $("cloudTaskHint").textContent = !profiles.find((p) => p.key === key())
    ? "请先选择有效的 Steam 档位。"
    : busy
      ? currentAction === "upload"
        ? "正在上传并校验，请等待完成。"
        : "正在处理当前操作，请稍候。"
      : agentUI?.blocksCloud
        ? "请先完成或取消当前 Agent 配置操作。"
        : agentUI?.background
          ? "项目对话正在后台同步；上传和刷新将优先处理。"
          : "可上传当前档位的进度。";
  agentUI?.renderButtons(busy);
}
async function call(action, args = {}) {
  if (busy) return;
  busy = true;
  currentAction = action;
  buttons();
  status("正在处理，请稍候…");
  try {
    const r = await window.bridge.call(action, {
      key: key(),
      ready: $("ready").checked,
      group: $("group").value,
      ...args,
    });
    if (!r.ok) throw Error([r.error, ...(r.notices || [])].join("\n"));
    status(
      (typeof r.data === "string" ? r.data : r.data?.message || "操作完成") +
        (r.notices?.length ? "\n" + r.notices.join("\n") : ""),
    );
    return r.data;
  } catch (e) {
    status(e.message, true);
  } finally {
    busy = false;
    currentAction = "";
    buttons();
  }
}
function text(tag, value) {
  const e = document.createElement(tag);
  e.textContent = value;
  return e;
}
function local() {
  const p = profiles.find((x) => x.key === key());
  $("local").replaceChildren();
  if (p) {
    $("local").append(
      text("strong", p.profile + " · " + p.files + " 个存档文件"),
    );
    $("local").append(metrics(p.summary, { compact: true }));
    $("overview").replaceChildren(
      text("h2", p.profile + " · 档位概览"),
      metrics(p.summary),
      characterTable(p.summary),
    );
    $("overview").parentElement.scrollTop = 0;
  } else {
    $("overview").replaceChildren(text("p", "请选择有效档位查看战绩。"));
  }
  buttons();
}
function clearCloud(message) {
  selection.replace(scope(), []);
  $("cloudVersion").replaceChildren(text("option", "请先刷新版本，再选择来源"));
  $("cloudVersion").firstElementChild.value = "";
  $("selectedVersion").replaceChildren(
    text("p", "选择版本只会预览，不会修改存档。"),
  );
  $("versions").replaceChildren(text("p", message));
  buttons();
}
function chooseVersion(id) {
  selection.select(id);
  const v = selection.selected(scope());
  $("cloudVersion").value = v?.id || "";
  $("selectedVersion").replaceChildren();
  if (v) {
    const p = profiles.find((p) => p.key === key());
    $("selectedVersion").append(
      text(
        "p",
        "覆盖目标：本机 " +
          p.profile +
          " · " +
          ($("group").value === "modded" ? "Mod 进度" : "原版进度"),
      ),
      text(
        "strong",
        "云端来源：" +
          (v.device || "来源未知") +
          " · " +
          new Date(v.createdAt).toLocaleString() +
          " · " +
          v.id.slice(0, 8),
      ),
      cloudSummary(v.summary),
    );
  } else $("selectedVersion").append(text("p", "请明确选择一个云端版本。"));
  buttons();
}
$("cloudVersion").onchange = () => chooseVersion($("cloudVersion").value);
$("overwrite").onclick = () => {
  const v = selection.selected(scope());
  if (!v) return status("请先刷新并选择要覆盖到本机的云端版本。", true);
  return mutate("download", { id: v.id });
};
function renderBackups() {
  $("backups").replaceChildren();
  if (!backupItems.length) $("backups").append(text("p", "本机还没有备份。"));
  for (const b of backupItems) {
    const row = text("div", "");
    row.className = "backup-entry";
    row.append(
      text(
        "strong",
        b.corrupt
          ? "损坏的备份（只能删除）"
          : b.profile +
              " · " +
              (b.group === "modded" ? "Mod 进度" : "原版进度"),
      ),
      text(
        "p",
        (b.createdAt ? new Date(b.createdAt).toLocaleString() : "时间未知") +
          " · " +
          b.id,
      ),
    );
    row.append(text("small", "Steam 账号：" + (b.account || "未知")));
    if (b.summary) row.append(cloudSummary(b.summary));
    const restore = text("button", "恢复此备份");
    restore.dataset.restoreKey = b.key;
    restore.onclick = () => mutate("restore", { id: b.key });
    const remove = text("button", "删除此备份");
    remove.dataset.backupRemove = b.key;
    remove.onclick = () => mutate("deleteBackup", { id: b.key });
    row.append(restore, remove);
    $("backups").append(row);
  }
  buttons();
}
async function refreshBackups() {
  const info = await call("backups");
  if (!info) return;
  backupItems = info.items;
  backupLimit = info.limit;
  backupCount = info.items.length;
  $("backupCapacity").textContent =
    "本机备份 " +
    backupCount +
    " / " +
    backupLimit +
    "（全部档位合计）" +
    (backupCount >= backupLimit
      ? "，请先在下方删除备份，再备份或覆盖。"
      : "；覆盖前自动备份也占用一个名额。");
  renderBackups();
}
async function init() {
  const previous = key();
  const data = await call("status");
  if (!data) return;
  profiles = data;
  $("profiles").replaceChildren();
  for (const p of data) {
    const o = text(
      "option",
      p.profile +
        " · " +
        (p.layout === "modded" ? "Mod 独立目录" : "游戏默认目录"),
    );
    o.value = p.key;
    $("profiles").append(o);
  }
  if (data.some((p) => p.key === previous)) $("profiles").value = previous;
  local();
  await refreshBackups();
  clearCloud("请刷新当前档位的云端版本。");
  if (!data.length)
    status(
      "没有发现带 progress.save 的档位。请先确认游戏安装和存档路径。",
      true,
    );
}
$("group").onchange = () => {
  clearCloud("切换同步组后请刷新云端版本。");
  $("backups").replaceChildren();
  init();
};
$("profiles").onchange = () => {
  local();
  renderBackups();
  clearCloud("切换档位后请刷新云端版本。");
};
$("login").onclick = () => call("login");
$("probe").onclick = () => call("probe");
$("backup").onclick = () => mutate("backup");
$("upload").onclick = () => mutate("upload");
async function refreshCloud() {
  clearCloud("正在刷新云端版本…");
  const versions = await call("versions");
  if (!versions) return false;
  selection.replace(scope(), versions);
  $("cloudVersion").replaceChildren(
    text("option", "请选择一个版本（不会自动覆盖）"),
  );
  $("cloudVersion").firstElementChild.value = "";
  for (const v of versions) {
    const option = text(
      "option",
      new Date(v.createdAt).toLocaleString() +
        " · " +
        (v.device || "来源未知") +
        " · " +
        v.id.slice(0, 8),
    );
    option.value = v.id;
    $("cloudVersion").append(option);
  }
  buttons();
  $("versions").replaceChildren();
  if (!versions.length)
    $("versions").append(
      text(
        "p",
        "夸克中还没有这个档位的完整版本。可在任一电脑上传你选择的进度。",
      ),
    );
  if (versions[0]?.branches > 1)
    $("versions").append(
      text(
        "p",
        "存在多个云端分支：请按设备和时间选择完整版本，工具不会自动覆盖。",
      ),
    );
  for (const v of versions) {
    const row = text("div", "");
    row.className = "version";
    const info = text("div", "");
    info.append(
      text("strong", new Date(v.createdAt).toLocaleString()),
      text("small", (v.device || "来源未知") + " · " + v.id.slice(0, 8)),
    );
    info.append(cloudSummary(v.summary));
    const button = text("button", "选为覆盖来源");
    button.onclick = () => {
      chooseVersion(v.id);
      $("cloudVersion").scrollIntoView({ block: "center" });
    };
    row.append(info, button);
    $("versions").append(row);
  }
  return true;
}
$("refresh").onclick = refreshCloud;
$("listBackups").onclick = refreshBackups;
async function mutate(action, args) {
  const result = await call(action, args);
  if (result !== undefined) {
    const message = $("status").textContent;
    if (action === "backup" || action === "deleteBackup")
      await refreshBackups();
    else {
      await init();
      if (action === "upload" && !(await refreshCloud())) {
        status(
          message +
            "\n上传已完成，但刷新云端版本失败：" +
            $("status").textContent,
          true,
        );
        return;
      }
    }
    status(message);
  }
}
agentUI = initAgentUI({ call, onChange: buttons });
init();
