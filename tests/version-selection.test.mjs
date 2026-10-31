import test from "node:test";
import assert from "node:assert/strict";
import { VersionSelection } from "../ui/version-selection.mjs";
const versions = [{ id: "one" }, { id: "two" }];
test("刷新不会自动选择首个云端版本；必须由使用者选择", () => {
  const s = new VersionSelection();
  s.replace("profile1|modded", versions);
  assert.equal(s.selected("profile1|modded"), null);
  s.select("two");
  assert.equal(s.selected("profile1|modded").id, "two");
});
test("档位或同步组变化后不能继续覆盖旧选择", () => {
  const s = new VersionSelection();
  s.replace("profile1|modded", versions);
  s.select("one");
  assert.equal(s.selected("profile2|modded"), null);
  assert.equal(s.selected("profile1|vanilla"), null);
});
test("刷新与无效选项清空旧选择", () => {
  const s = new VersionSelection();
  s.replace("scope", versions);
  s.select("one");
  s.replace("scope", versions);
  assert.equal(s.selected("scope"), null);
  s.select("two");
  s.select("unknown");
  assert.equal(s.selected("scope"), null);
});
