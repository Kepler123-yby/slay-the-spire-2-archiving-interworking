const NAMES = {
  "CHARACTER.IRONCLAD": "铁甲战士",
  "CHARACTER.SILENT": "静默猎手",
  "CHARACTER.REGENT": "储君",
  "CHARACTER.NECROBINDER": "亡灵契约师",
  "CHARACTER.DEFECT": "故障机器人",
};
const number = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
export function summarize(
  progress,
  { environment = null, modifiedAt = null } = {},
) {
  if (
    !progress ||
    typeof progress !== "object" ||
    !Array.isArray(progress.character_stats)
  )
    return null;
  const characters = progress.character_stats
    .filter(
      (c) =>
        c && typeof c.id === "string" && c.id !== "CHARACTER.RANDOM_CHARACTER",
    )
    .slice(0, 128)
    .map((c) => ({
      id: c.id.slice(0, 128),
      name: NAMES[c.id] || c.id.replace(/^CHARACTER\./, "").slice(0, 64),
      wins: number(c.total_wins),
      losses: number(c.total_losses),
      ascension: number(c.max_ascension),
      playtimeSeconds: number(c.playtime),
    }));
  const wins = characters.every((c) => c.wins !== null)
    ? characters.reduce((n, c) => n + c.wins, 0)
    : null;
  const losses = characters.every((c) => c.losses !== null)
    ? characters.reduce((n, c) => n + c.losses, 0)
    : null;
  return {
    version: 2,
    characters,
    wins,
    losses,
    playtimeSeconds: number(progress.total_playtime),
    modifiedAt,
    environment,
  };
}
