import test from "node:test";
import assert from "node:assert/strict";
import { parseOutput, result } from "../src/quark.mjs";
import { saveRoot } from "../src/platform.mjs";
test("业务失败不因进程返回零而被判为成功", () => {
  assert.throws(
    () => result(parseOutput('{"type":"result","code":-1,"msg":"未授权"}\n')),
    /未授权/,
  );
  assert.throws(() => result([]));
  assert.throws(() =>
    result([{ type: "result", code: 0, data: { failCount: 1 } }]),
  );
});
test("NDJSON进度、结果及artifact均保留", () => {
  const e = parseOutput(
    'noise\n{"type":"progress"}\r\n{"type":"result","code":0}\n{"type":"artifact"}\n',
  );
  assert.equal(e.length, 3);
  assert.deepEqual(result(e), {});
});
test("平台路径独立解析", () => {
  assert.equal(
    saveRoot("darwin", "/Users/test"),
    "/Users/test/Library/Application Support/SlayTheSpire2/steam",
  );
  assert.equal(
    saveRoot("win32", "C:\\Users\\test", "C:\\Users\\test\\AppData\\Roaming"),
    "C:\\Users\\test\\AppData\\Roaming\\SlayTheSpire2\\steam",
  );
  assert.throws(() => saveRoot("win32", "C:\\Users\\test", ""), /APPDATA/);
  assert.throws(() => saveRoot("linux"));
});
