import { metrics, characterTable, cloudSummary } from "./summary-view.mjs";
const $ = (id) => document.getElementById(id);
let busy = false,
  profiles = [];
function status(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}
function key() {
  return $("profiles").value;
}
function buttons() {
  document
    .querySelectorAll("button,select")
    .forEach((b) => (b.disabled = busy));
  $("upload").disabled = busy || !profiles.find((p) => p.key === key());
}
async function call(action, args = {}) {
  if (busy) return;
  busy = true;
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
  if (!data.length)
    status(
      "没有发现带 progress.save 的档位。请先确认游戏安装和存档路径。",
      true,
    );
}
$("group").onchange = () => {
  $("versions").replaceChildren(text("p", "切换同步组后请刷新云端版本。"));
  $("backups").replaceChildren();
  init();
};
$("profiles").onchange = () => {
  local();
  $("versions").replaceChildren(text("p", "切换档位后请刷新云端版本。"));
};
$("login").onclick = () => call("login");
$("probe").onclick = () => call("probe");
$("backup").onclick = () => call("backup");
$("upload").onclick = () => mutate("upload");
$("refresh").onclick = async () => {
  const versions = await call("versions");
  if (!versions) return;
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
    const button = text("button", "下载并应用");
    button.onclick = () => mutate("download", { id: v.id });
    row.append(info, button);
    $("versions").append(row);
  }
};
$("listBackups").onclick = async () => {
  const ids = await call("backups");
  if (!ids) return;
  $("backups").replaceChildren();
  if (!ids.length) $("backups").append(text("p", "还没有本地备份。"));
  for (const id of ids) {
    const b = text("button", "恢复 " + id);
    b.onclick = () => mutate("restore", { id });
    $("backups").append(b);
  }
};
async function mutate(action, args) {
  const result = await call(action, args);
  if (result !== undefined) {
    const message = $("status").textContent;
    await init();
    status(message);
  }
}
init();
