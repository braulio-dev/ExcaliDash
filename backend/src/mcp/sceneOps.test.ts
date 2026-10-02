import { describe, expect, it } from "vitest";
import { applySceneOperations, SceneOpError } from "./sceneOps";
import { compactScene } from "./compact";

const byId = (elements: any[]) => new Map(elements.map((el) => [el.id, el]));

describe("applySceneOperations", () => {
  it("adds labelled shapes and an arrow bound to both", () => {
    const result = applySceneOperations([], [
      { op: "add", element: { type: "rectangle", id: "a", x: 0, y: 0, width: 200, height: 100, label: "Start" } },
      { op: "add", element: { type: "rectangle", id: "b", x: 400, y: 0, width: 200, height: 100, label: "End" } },
      { op: "add", element: { type: "arrow", id: "ab", startId: "a", endId: "b", label: "next" } },
    ]);
    const els = byId(result.elements);
    expect(result.created).toEqual(["a", "b", "ab"]);
    const arrow = els.get("ab");
    expect(arrow.startBinding.elementId).toBe("a");
    expect(arrow.endBinding.elementId).toBe("b");
    // Arrow runs from a's right edge to b's left edge (plus the binding gap).
    expect(arrow.x).toBeCloseTo(206);
    expect(arrow.points[1][0]).toBeCloseTo(188);
    expect(els.get("a").boundElements.map((b: any) => b.id)).toContain("ab");
    const label = result.elements.find((el) => el.type === "text" && el.containerId === "a")!;
    expect(label.text).toBe("Start");
    expect(label.x + label.width / 2).toBeCloseTo(100);
    expect(label.y + label.height / 2).toBeCloseTo(50);
    expect(Object.values(result.before).every((v) => v === null)).toBe(true);
  });

  it("moving a shape recentres its label, re-routes arrows and bumps versions", () => {
    const first = applySceneOperations([], [
      { op: "add", element: { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 100, label: "A" } },
      { op: "add", element: { type: "ellipse", id: "b", x: 300, y: 0, width: 100, height: 100 } },
      { op: "add", element: { type: "arrow", id: "ab", startId: "a", endId: "b" } },
    ]);
    const moved = applySceneOperations(first.elements, [{ op: "update", id: "b", set: { y: 300 } }]);
    const els = byId(moved.elements);
    expect(els.get("b").y).toBe(300);
    expect(els.get("b").version).toBe(2);
    const arrow = els.get("ab");
    expect(arrow.version).toBe(2);
    expect(arrow.y + arrow.points[1][1]).toBeGreaterThan(250);
    expect(Object.keys(moved.before).sort()).toEqual(["ab", "b"]);
    expect(moved.before.b!.y).toBe(0);
  });

  it("updates and removes labels", () => {
    const first = applySceneOperations([], [
      { op: "add", element: { type: "diamond", id: "d", x: 0, y: 0, width: 200, height: 120, label: "Yes?" } },
    ]);
    const relabelled = applySceneOperations(first.elements, [{ op: "update", id: "d", set: { label: "Approved?" } }]);
    expect(relabelled.elements.find((el) => el.type === "text" && !el.isDeleted)!.text).toBe("Approved?");
    const cleared = applySceneOperations(relabelled.elements, [{ op: "update", id: "d", set: { label: "" } }]);
    expect(cleared.elements.filter((el) => el.type === "text" && !el.isDeleted)).toHaveLength(0);
    expect(byId(cleared.elements).get("d").boundElements).toBeNull();
  });

  it("deleting a shape deletes its label and detaches arrows", () => {
    const first = applySceneOperations([], [
      { op: "add", element: { type: "rectangle", id: "a", label: "A" } },
      { op: "add", element: { type: "rectangle", id: "b", x: 400 } },
      { op: "add", element: { type: "arrow", id: "ab", startId: "a", endId: "b" } },
    ]);
    const result = applySceneOperations(first.elements, [{ op: "delete", id: "a" }]);
    const els = byId(result.elements);
    expect(els.get("a").isDeleted).toBe(true);
    expect(result.elements.find((el) => el.type === "text")!.isDeleted).toBe(true);
    expect(els.get("ab").startBinding).toBeNull();
    expect(els.get("b").boundElements.map((b: any) => b.id)).toEqual(["ab"]);
  });

  it("rejects unknown ids, duplicate ids and arrows to text", () => {
    expect(() => applySceneOperations([], [{ op: "delete", id: "nope" }])).toThrow(SceneOpError);
    expect(() =>
      applySceneOperations([], [
        { op: "add", element: { type: "rectangle", id: "x" } },
        { op: "add", element: { type: "ellipse", id: "x" } },
      ]),
    ).toThrow(/already exists/);
    expect(() =>
      applySceneOperations([], [
        { op: "add", element: { type: "text", id: "t", text: "hi" } },
        { op: "add", element: { type: "arrow", endId: "t" } },
      ]),
    ).toThrow(/only attach to shapes/);
  });

  it("centres text and shapes when anchor is center", () => {
    const result = applySceneOperations([], [
      { op: "add", element: { type: "text", id: "t", text: "Title", x: 500, y: 100, anchor: "center", fontSize: 30 } },
      { op: "add", element: { type: "rectangle", id: "r", x: 500, y: 300, width: 200, height: 80, anchor: "center" } },
    ]);
    const els = byId(result.elements);
    expect(els.get("t").x + els.get("t").width / 2).toBeCloseTo(500);
    expect(els.get("r").x).toBe(400);
    expect(els.get("r").y).toBe(260);
  });
});

describe("compactScene", () => {
  it("folds bound labels into their containers and skips deleted elements", () => {
    const { elements } = applySceneOperations([], [
      { op: "add", element: { type: "rectangle", id: "a", label: "Hello", strokeColor: "#534AB7" } },
      { op: "add", element: { type: "rectangle", id: "gone" } },
    ]);
    const after = applySceneOperations(elements, [{ op: "delete", id: "gone" }]).elements;
    const scene = compactScene(after) as any;
    expect(scene.elementCount).toBe(1);
    expect(scene.elements[0]).toMatchObject({ id: "a", type: "rectangle", label: "Hello" });
    // With a single element its whole style is the shared default.
    expect(scene.styleDefaults).toMatchObject({ strokeColor: "#534AB7", rounded: true });
  });

  it("lists shared styles once and only differences per element", () => {
    const { elements } = applySceneOperations([], [
      { op: "add", element: { type: "rectangle", id: "a", roughness: 0, strokeWidth: 1 } },
      { op: "add", element: { type: "rectangle", id: "b", roughness: 0, strokeWidth: 1 } },
      { op: "add", element: { type: "rectangle", id: "c", roughness: 0, strokeWidth: 4, strokeColor: "#e03131" } },
    ]);
    const scene = compactScene(elements) as any;
    expect(scene.styleDefaults).toMatchObject({ roughness: 0, strokeWidth: 1, strokeColor: "#1e1e1e" });
    expect(scene.elements[0]).toEqual({ id: "a", type: "rectangle", x: 0, y: 0, w: 160, h: 80 });
    expect(scene.elements[2]).toMatchObject({ id: "c", strokeWidth: 4, strokeColor: "#e03131" });
    expect(scene.elements[2].roughness).toBeUndefined();
  });

  it("filters by frame, area and ids, and can return only a summary", () => {
    const { elements } = applySceneOperations([], [
      { op: "add", element: { type: "frame", id: "f", x: 0, y: 0, width: 300, height: 200, name: "One" } },
      { op: "add", element: { type: "rectangle", id: "in", x: 20, y: 20, frameId: "f" } },
      { op: "add", element: { type: "rectangle", id: "out", x: 500, y: 500 } },
    ]);
    expect((compactScene(elements, { frameId: "f" }) as any).elements.map((e: any) => e.id)).toEqual(["in", "f"]);
    expect((compactScene(elements, { area: { x: 450, y: 450, width: 300, height: 300 } }) as any).elements.map((e: any) => e.id)).toEqual(["out"]);
    expect((compactScene(elements, { ids: ["out"] }) as any).elements).toHaveLength(1);
    const summary = compactScene(elements, { summaryOnly: true }) as any;
    expect(summary.elements).toBeUndefined();
    expect(summary).toMatchObject({ totalElements: 3, frames: [{ id: "f", name: "One", elementCount: 1 }] });
  });
});
