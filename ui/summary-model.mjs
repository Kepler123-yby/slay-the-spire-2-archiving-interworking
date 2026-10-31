const numeric = (n) =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
export function model(summary) {
  const complete = Array.isArray(summary?.characters);
  const characters = complete
    ? summary.characters
        .slice(0, 128)
        .filter((c) => c && typeof c.id === "string")
        .map((c) => ({
          name: String(c.name || c.id).slice(0, 64),
          wins: numeric(c.wins),
          losses: numeric(c.losses),
          ascension: numeric(c.ascension),
        }))
    : summary &&
        (numeric(summary.defectAscension) !== null ||
          numeric(summary.defectWins) !== null)
      ? [
          {
            name: "故障机器人",
            wins: numeric(summary.defectWins),
            losses: null,
            ascension: numeric(summary.defectAscension),
          },
        ]
      : [];
  return {
    complete,
    characters,
    wins: complete ? numeric(summary.wins) : null,
    losses: complete ? numeric(summary.losses) : null,
    playtimeSeconds: numeric(summary?.playtimeSeconds),
    modifiedAt: summary?.modifiedAt,
    environment: summary?.environment,
  };
}
export function modsLabel(environment) {
  const m = environment?.mods;
  if (
    numeric(m?.loaded) === null ||
    numeric(m?.detected) === null ||
    m.detected < m.loaded
  )
    return "Mod 数量未记录";
  return `Mod 已加载 ${m.loaded} / 检测到 ${m.detected}`;
}
export function record(value) {
  return numeric(value) === null ? "—" : String(value);
}
export function winRate(c) {
  const total = c.wins + c.losses;
  return c.wins === null || c.losses === null || !total
    ? "—"
    : Math.round((c.wins / total) * 100) + "%";
}
export function duration(seconds) {
  return numeric(seconds) === null
    ? "时长未记录"
    : `累计 ${(seconds / 3600).toFixed(1)} 小时`;
}
export function date(value) {
  const d = new Date(value);
  return value && Number.isFinite(d.getTime()) ? d.toLocaleString() : "未记录";
}
