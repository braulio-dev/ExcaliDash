import { describe, expect, it } from "vitest";
import { applySceneOperations, SceneOpError } from "./sceneOps";
import { compactScene } from "./compact";

const byId = (elements: any[]) => new Map(elements.map((el) => [el.id, el]));

describe("frames", () => {
  const framed = () =>
    applySceneOperations([], [
      { op: "add", element: { type: "rectangle", id: "a", x: 20, y: 40, label: "A" } },
      { op: "add", element: { type: "frame", id: "f", x: 0, y: 0, width: 400, height: 300, name: "Flow" } },
      { op: "update", id: "a", set: { frameId: "f" } },
    ]);

  it("puts elements and their labels in a frame, ordered below it", () => {
    const result = framed();
    const els = byId(result.elements);
    expect(els.get("f")).toMatchObject({ type: "frame", name: "Flow" });
    expect(els.get("a").frameId).toBe("f");
    const label = result.elements.find((el) => el.type === "text")!;
    expect(label.frameId).toBe("f");
    const order = result.elements.map((el) => el.id);
    expect(order.indexOf("f")).toBeGreaterThan(order.indexOf("a"));
    expect(order.indexOf("f")).toBeGreaterThan(order.indexOf(label.id));
  });

  it("moving a frame moves its contents", () => {
    const moved = applySceneOperations(framed().elements, [{ op: "update", id: "f", set: { x: 100, y: 50 } }]);
    const els = byId(moved.elements);
    expect(els.get("a")).toMatchObject({ x: 120, y: 90 });
    const label = moved.elements.find((el) => el.type === "text")!;
    expect(label.x + label.width / 2).toBeCloseTo(120 + 80);
  });

  it("deleting a frame keeps its contents, unframed", () => {
    const result = applySceneOperations(framed().elements, [{ op: "delete", id: "f" }]);
    const els = byId(result.elements);
    expect(els.get("f").isDeleted).toBe(true);
    expect(els.get("a").isDeleted).toBeFalsy();
    expect(els.get("a").frameId).toBeNull();
  });

  it("rejects non-frames and nested frames", () => {
    const base = framed().elements;
    expect(() => applySceneOperations(base, [{ op: "update", id: "a", set: { frameId: "a" } }])).toThrow(/not a frame/);
    expect(() =>
      applySceneOperations(base, [
        { op: "add", element: { type: "frame", id: "g" } },
        { op: "update", id: "g", set: { frameId: "f" } },
      ]),
    ).toThrow(/nested/);
  });

  it("shows frame names and membership in the compact view", () => {
    const scene = compactScene(framed().elements);
    expect(scene.elements.find((e) => e.id === "f")).toMatchObject({ type: "frame", name: "Flow" });
    expect(scene.elements.find((e) => e.id === "a")).toMatchObject({ frameId: "f", label: "A" });
  });
});

describe("other element types", () => {
  it("adds free draw, images and embeds", () => {
    const result = applySceneOperations([], [
      { op: "add", element: { type: "freedraw", id: "pen", x: 10, y: 10, points: [[0, 0], [5, 8], [20, 3]] } },
      { op: "add", element: { type: "image", id: "img", fileId: "abc", x: 0, y: 100, width: 64, height: 32 } },
      { op: "add", element: { type: "embeddable", id: "yt", link: "https://www.youtube.com/watch?v=x" } },
    ]);
    const els = byId(result.elements);
    expect(els.get("pen")).toMatchObject({ type: "freedraw", width: 20, height: 8, simulatePressure: true });
    expect(els.get("img")).toMatchObject({ type: "image", fileId: "abc", status: "saved", scale: [1, 1] });
    expect(els.get("yt")).toMatchObject({ type: "embeddable", link: "https://www.youtube.com/watch?v=x", width: 560 });
  });

  it("validates required fields", () => {
    expect(() => applySceneOperations([], [{ op: "add", element: { type: "freedraw", points: [[0, 0]] } }])).toThrow(SceneOpError);
    expect(() => applySceneOperations([], [{ op: "add", element: { type: "image" } }])).toThrow(/image/);
    expect(() => applySceneOperations([], [{ op: "add", element: { type: "embeddable" } }])).toThrow(/link/);
  });

  it("lets arrows attach to images", () => {
    const result = applySceneOperations([], [
      { op: "add", element: { type: "image", id: "img", fileId: "abc", x: 0, y: 0, width: 100, height: 100 } },
      { op: "add", element: { type: "rectangle", id: "r", x: 300, y: 0 } },
      { op: "add", element: { type: "arrow", id: "ar", startId: "img", endId: "r" } },
    ]);
    expect(byId(result.elements).get("ar").startBinding.elementId).toBe("img");
  });
});

describe("bulk operations", () => {
  const three = () =>
    applySceneOperations([], [
      { op: "add", element: { type: "rectangle", id: "a", x: 10, y: 10, label: "A" } },
      { op: "add", element: { type: "rectangle", id: "b", x: 200, y: 10 } },
      { op: "add", element: { type: "rectangle", id: "c", x: 900, y: 900 } },
    ]).elements;

  it("updates and deletes many elements at once", () => {
    const updated = applySceneOperations(three(), [{ op: "update", ids: ["a", "b"], set: { strokeColor: "#e03131" } }]);
    expect(updated.elements.filter((el) => el.strokeColor === "#e03131").map((el) => el.id)).toEqual(["a", "b"]);
    const deleted = applySceneOperations(three(), [{ op: "delete", ids: ["a", "c"] }]);
    expect(deleted.elements.filter((el) => !el.isDeleted).map((el) => el.id)).toEqual(["b"]);
    expect(() => applySceneOperations(three(), [{ op: "delete", ids: ["a", "nope"] }])).toThrow(/nope/);
    expect(() => applySceneOperations(three(), [{ op: "update", set: { x: 1 } }])).toThrow(/id/);
  });

  it("fills a frame with what lies inside it, by area or by ids", () => {
    const withFrame = applySceneOperations(three(), [
      { op: "add", element: { type: "frame", id: "f", x: 0, y: 0, width: 500, height: 200 } },
      { op: "assign_frame", frameId: "f" },
    ]).elements;
    const byId = new Map(withFrame.map((el) => [el.id, el]));
    expect(byId.get("a")!.frameId).toBe("f");
    expect(byId.get("b")!.frameId).toBe("f");
    expect(byId.get("c")!.frameId).toBeFalsy();
    expect(withFrame.find((el) => el.type === "text")!.frameId).toBe("f");

    const byArea = applySceneOperations(withFrame, [
      { op: "add", element: { type: "frame", id: "g", x: 800, y: 800, width: 400, height: 300 } },
      { op: "assign_frame", frameId: "g", area: { x: 850, y: 850, width: 300, height: 200 } },
    ]).elements;
    expect(byArea.find((el) => el.id === "c")!.frameId).toBe("g");
    expect(() => applySceneOperations(three(), [{ op: "assign_frame", frameId: "a" }])).toThrow(/not a frame/);
  });
});

describe("erase and reorder", () => {
  const scene = () =>
    applySceneOperations([], [
      { op: "add", element: { type: "rectangle", id: "a", x: 0, y: 0, width: 50, height: 50, label: "A" } },
      { op: "add", element: { type: "rectangle", id: "b", x: 200, y: 0, width: 50, height: 50 } },
      { op: "add", element: { type: "rectangle", id: "c", x: 400, y: 0, width: 50, height: 50 } },
    ]).elements;

  it("erases everything touching an area, labels included", () => {
    const result = applySceneOperations(scene(), [{ op: "erase", x: -10, y: -10, width: 270, height: 30 }]);
    const live = result.elements.filter((el) => !el.isDeleted).map((el) => el.id);
    expect(live).toEqual(["c"]);
    expect(() => applySceneOperations(scene(), [{ op: "erase", x: 1000, y: 1000, width: 5, height: 5 }])).toThrow(/Nothing to erase/);
  });

  it("reorders elements and reports the previous order", () => {
    const before = scene();
    const result = applySceneOperations(before, [{ op: "reorder", ids: ["c"], to: "back" }]);
    expect(result.order[0]).toBe("c");
    expect(result.orderBefore).toEqual(before.map((el) => el.id));
    expect(applySceneOperations(before, [{ op: "update", id: "a", set: { x: 5 } }]).orderBefore).toBeNull();
  });
});
