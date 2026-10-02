import type { SceneElement } from "./elements";

// Ordering and area helpers for scene operations: erasing by region, layer
// order (front/back) and keeping frame children directly below their frame,
// which is the order Excalidraw expects.

export type Area = { x: number; y: number; width: number; height: number };

const boundsOf = (el: SceneElement): Area => {
  if (Array.isArray(el.points) && el.points.length) {
    const xs = el.points.map((p: number[]) => el.x + p[0]);
    const ys = el.points.map((p: number[]) => el.y + p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
  }
  return { x: el.x, y: el.y, width: el.width, height: el.height };
};

const overlaps = (a: Area, b: Area) =>
  a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;

// Ids of live elements the eraser would touch inside `area`. Bound labels are
// left out: they go with their container.
export const elementsInArea = (elements: SceneElement[], area: Area): string[] =>
  elements
    .filter((el) => !el.isDeleted && !(el.type === "text" && el.containerId))
    .filter((el) => overlaps(boundsOf(el), area))
    .map((el) => el.id);

// Move `ids` (keeping their relative order) to the top or bottom of the stack.
export const reorderIds = (order: string[], ids: string[], to: "front" | "back"): string[] => {
  const moving = new Set(ids);
  const picked = order.filter((id) => moving.has(id));
  const rest = order.filter((id) => !moving.has(id));
  return to === "front" ? [...rest, ...picked] : [...picked, ...rest];
};

// Place every frame immediately after its last child so children render
// beneath it, as Excalidraw does when elements are added to a frame.
export const orderFramesAfterChildren = (order: string[], byId: Map<string, SceneElement>): string[] => {
  const frames = order.filter((id) => byId.get(id)?.type === "frame" && !byId.get(id)?.isDeleted);
  let next = [...order];
  for (const frameId of frames) {
    const children = next.filter((id) => byId.get(id)?.frameId === frameId);
    if (children.length === 0) continue;
    const withoutFrame = next.filter((id) => id !== frameId);
    const lastChild = Math.max(...children.map((id) => withoutFrame.indexOf(id)));
    withoutFrame.splice(lastChild + 1, 0, frameId);
    next = withoutFrame;
  }
  return next;
};
