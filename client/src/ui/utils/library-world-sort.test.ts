import { describe, it, expect } from "vitest";
import { sortLibraryWorldsForLocale } from "./library-world-sort";

const BIANJING = "world_2026-04-19T08-31-24";
const POST_VICTORY = "world_2026-04-19T17-12-41";

function w(id: string) {
  return { id, worldName: id } as any;
}

describe("sortLibraryWorldsForLocale", () => {
  it("中文界面把汴京排在前面", () => {
    const r = sortLibraryWorldsForLocale([w(POST_VICTORY), w(BIANJING)], "zh");
    expect(r[0].id).toBe(BIANJING);
  });

  it("英文界面把 Post-Victory 排在前面", () => {
    const r = sortLibraryWorldsForLocale([w(BIANJING), w(POST_VICTORY)], "en");
    expect(r[0].id).toBe(POST_VICTORY);
  });

  it("zh-CN 也算中文（startsWith 判断）", () => {
    const r = sortLibraryWorldsForLocale([w(POST_VICTORY), w(BIANJING)], "zh-CN");
    expect(r[0].id).toBe(BIANJING);
  });

  it("大写 ZH 也算中文", () => {
    const r = sortLibraryWorldsForLocale([w(POST_VICTORY), w(BIANJING)], "ZH");
    expect(r[0].id).toBe(BIANJING);
  });

  it("未知世界排在两个样例之后", () => {
    const r = sortLibraryWorldsForLocale(
      [w("world_unknown"), w(BIANJING), w(POST_VICTORY)],
      "zh",
    );
    expect(r[2].id).toBe("world_unknown");
  });

  it("多个未知世界按 id 倒序（稳定的回落顺序）", () => {
    const r = sortLibraryWorldsForLocale(
      [w("world_a"), w("world_b"), w("world_c")],
      "zh",
    );
    expect(r.map((x) => x.id)).toEqual(["world_c", "world_b", "world_a"]);
  });

  it("不修改入参数组", () => {
    const input = [w(POST_VICTORY), w(BIANJING)];
    const before = input.map((x) => x.id);
    sortLibraryWorldsForLocale(input, "zh");
    expect(input.map((x) => x.id)).toEqual(before);
  });

  it("空数组返回空数组", () => {
    expect(sortLibraryWorldsForLocale([], "zh")).toEqual([]);
  });

  it("只有一个世界时原样返回", () => {
    const r = sortLibraryWorldsForLocale([w(BIANJING)], "en");
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe(BIANJING);
  });
});
