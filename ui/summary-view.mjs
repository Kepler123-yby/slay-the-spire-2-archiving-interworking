import {
  model,
  modsLabel,
  record,
  winRate,
  duration,
  date,
} from "./summary-model.mjs";
export function element(tag, value, className) {
  const e = document.createElement(tag);
  if (value !== undefined) e.textContent = value;
  if (className) e.className = className;
  return e;
}
export function metrics(summary, { compact = false } = {}) {
  const m = model(summary),
    wrapper = element("div", undefined, "save-metrics");
  wrapper.append(
    element(
      "p",
      `${record(m.wins)} 胜 / ${record(m.losses)} 负 · ${duration(m.playtimeSeconds)}`,
    ),
    element("p", modsLabel(m.environment)),
  );
  if (compact) return wrapper;
  if (m.environment?.mods)
    wrapper.append(
      element("small", `上次启动日志 · ${date(m.environment.mods.observedAt)}`),
    );
  if (m.environment?.gameVersion)
    wrapper.append(
      element(
        "p",
        "上次启动版本 " + String(m.environment.gameVersion).slice(0, 80),
      ),
    );
  wrapper.append(element("small", "存档更新 " + date(m.modifiedAt)));
  return wrapper;
}
export function characterTable(summary) {
  const m = model(summary),
    wrapper = element("div", undefined, "character-record");
  if (!m.complete)
    wrapper.append(
      element("p", "此版本未记录完整角色战绩和 Mod 信息。", "hint"),
    );
  if (!m.characters.length) {
    wrapper.append(element("p", "暂无角色战绩摘要。"));
    return wrapper;
  }
  const table = element("table"),
    caption = element("caption", "角色战绩");
  table.append(caption);
  const head = element("thead"),
    row = element("tr");
  for (const name of ["角色", "胜利", "失败", "胜率", "最高进阶"]) {
    const th = element("th", name);
    th.scope = "col";
    row.append(th);
  }
  head.append(row);
  table.append(head);
  const body = element("tbody");
  for (const c of m.characters) {
    const row = element("tr");
    const name = element("th", c.name);
    name.scope = "row";
    row.append(
      name,
      ...[
        record(c.wins),
        record(c.losses),
        winRate(c),
        record(c.ascension),
      ].map((value) => element("td", value)),
    );
    body.append(row);
  }
  table.append(body);
  wrapper.append(table);
  return wrapper;
}
export function cloudSummary(summary) {
  const wrapper = element("div", undefined, "cloud-summary");
  wrapper.append(metrics(summary));
  const details = element("details"),
    label = element("summary", "查看所有角色战绩");
  details.append(label, characterTable(summary));
  wrapper.append(details);
  return wrapper;
}
