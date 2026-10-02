import { describe, expect, it } from "vitest";
import { isUnchangedSince } from "./changes";

const box = { id: "a", type: "rectangle", x: 10, y: 20, width: 100, height: 50, version: 3, versionNonce: 7, index: null, boundElements: null, strokeColor: "#000" } as any;

describe("isUnchangedSince", () => {
  it("ignores bookkeeping the editor rewrites on its own", () => {
    const resaved = { ...box, version: 4, versionNonce: 99, index: "a1", updated: 123, boundElements: [], frameId: null, extra: 1 };
    expect(isUnchangedSince(resaved, box)).toBe(true);
  });

  it("detects real edits", () => {
    expect(isUnchangedSince({ ...box, x: 300 }, box)).toBe(false);
    expect(isUnchangedSince({ ...box, strokeColor: "#f00" }, box)).toBe(false);
    expect(isUnchangedSince({ ...box, isDeleted: true }, box)).toBe(false);
    expect(isUnchangedSince(undefined, box)).toBe(false);
  });

  it("treats deleted and missing elements alike", () => {
    expect(isUnchangedSince(undefined, null)).toBe(true);
    expect(isUnchangedSince({ ...box, isDeleted: true }, null)).toBe(true);
    expect(isUnchangedSince(undefined, { ...box, isDeleted: true })).toBe(true);
    expect(isUnchangedSince(box, null)).toBe(false);
  });

  it("tolerates float noise in coordinates", () => {
    expect(isUnchangedSince({ ...box, x: 10.0000001 }, box)).toBe(true);
  });
});
