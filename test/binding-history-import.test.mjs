import test from "node:test";
import assert from "node:assert/strict";
import { parseBindingHistory } from "../scripts/import-binding-history.mjs";

test("绑定历史导入器支持 CSV 和 JSON 并保留批次信息", () => {
  const csv = parseBindingHistory(
    "bvid,courseName,batchLabel\nBV1234567890,Agent,本周\n无效行",
    ".csv",
    { sourceFile: "绑定成功.csv" },
  );
  assert.deepEqual(csv, [{
    bvid: "BV1234567890",
    courseName: "Agent",
    batchLabel: "本周",
    sourceFile: "绑定成功.csv",
  }]);
  const json = parseBindingHistory(
    JSON.stringify({ records: [{ BV号: "BV1234567891", 课程: "AI视频", 批次: "上周" }] }),
    ".json",
    { sourceFile: "history.json" },
  );
  assert.equal(json[0].bvid, "BV1234567891");
  assert.equal(json[0].courseName, "AI视频");
  assert.equal(json[0].batchLabel, "上周");
});
