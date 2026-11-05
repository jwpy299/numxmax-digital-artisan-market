import { describe, expect, it } from "vitest";
import { stableSerialize } from "./stableSerialize";

describe("stableSerialize 复杂度与循环边界", () => {
  it("不同循环图都 fail-closed，共享但非循环子图仍可序列化", () => {
    const first: { next?: unknown } = {};
    const second: { next?: unknown } = { next: first };
    first.next = second;
    const self: { next?: unknown } = {};
    self.next = self;
    expect(() => stableSerialize(first)).toThrow(
      "stable_serialize_circular_unsupported",
    );
    expect(() => stableSerialize(self)).toThrow(
      "stable_serialize_circular_unsupported",
    );
    const shared = { value: 1 };
    expect(() =>
      stableSerialize({ left: shared, right: shared }),
    ).not.toThrow();
  });

  it("TypedArray 索引不重复编码，额外自定义属性仍保留", () => {
    const view = new Uint8Array(12_000);
    (view as Uint8Array & { note?: string }).note = "keep";
    const result = stableSerialize(view);
    expect(result).toContain("note");
    expect(result).not.toContain('"0":number:0');
    expect(result.length).toBeLessThan(100_000);
  });

  it("稀疏数组 hole 在循环内计入节点与输出预算", () => {
    expect(() => stableSerialize(new Array(100_000_000))).toThrow(
      "stable_serialize_too_complex",
    );
    expect(stableSerialize(new Array(3))).toContain("hole");
  });
  it("二进制超过独立预算在分配属性名和字节数组前 fail-closed", () => {
    expect(() => stableSerialize(new Uint8Array(65_537))).toThrow(
      "stable_serialize_binary_too_large",
    );
    expect(() => stableSerialize(new Uint8Array(65_536))).not.toThrow();
  });
});
