import {
  addBoundRef,
  binding,
  BINDABLE_TYPES,
  bump,
  centerLabel,
  connect,
  createEmbeddable,
  createFrame,
  createFreedraw,
  createImage,
  createLinear,
  createShape,
  createText,
  linearBox,
  remeasureText,
  removeBoundRef,
  roundnessFor,
  type SceneElement,
} from "./elements";
import { elementsInArea, elementsWithin, orderFramesAfterChildren, reorderIds } from "./sceneExtras";
import type { ElementProps, SceneOperation, TouchedState } from "./sceneTypes";

export type { ElementProps, SceneOperation, TouchedState } from "./sceneTypes";

const targetIds = (operation: { id?: string; ids?: string[] }): string[] => {
  const ids = [...(operation.id ? [operation.id] : []), ...(operation.ids ?? [])];
  if (ids.length === 0) throw new SceneOpError("Give `id` or `ids`");
  return ids;
};

// Applies an agent's add/update/delete operations to a scene. Pure: returns
// the next element list plus the before/after state of every touched element,
// which is what gets stored for undo/redo.

export class SceneOpError extends Error {}

const STYLE_KEYS = [
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "angle",
  "link",
  "locked",
  "groupIds",
  "startArrowhead",
  "endArrowhead",
] as const;

const pick = (props: ElementProps) =>
  Object.fromEntries(
    STYLE_KEYS.filter((k) => props[k] !== undefined).map((k) => [k, props[k]]),
  );

const isLinear = (el: SceneElement) => el.type === "arrow" || el.type === "line";

export const applySceneOperations = (
  elements: SceneElement[],
  operations: SceneOperation[],
) => {
  const original = new Map(elements.map((el) => [el.id, el]));
  const current = new Map(original);
  const order = elements.map((el) => el.id);
  const touched: string[] = [];
  const created: string[] = [];

  const live = (id: string | null | undefined) => {
    const el = id ? current.get(id) : undefined;
    return el && !el.isDeleted ? el : undefined;
  };
  const need = (id: string) => {
    const el = live(id);
    if (!el) throw new SceneOpError(`No element with id "${id}"`);
    return el;
  };
  const put = (el: SceneElement) => {
    if (!current.has(el.id)) order.push(el.id);
    current.set(el.id, el);
    if (!touched.includes(el.id)) touched.push(el.id);
  };
  const boundText = (el: SceneElement) =>
    (el.boundElements ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { id: string }) => live(b.id))
      .find(Boolean) as SceneElement | undefined;

  // Re-route an arrow after either end's shape moved or was re-bound.
  const reroute = (arrow: SceneElement): SceneElement => {
    const start = live(arrow.startBinding?.elementId);
    const end = live(arrow.endBinding?.elementId);
    const pts: [number, number][] = arrow.points;
    const first = { x: arrow.x + pts[0][0], y: arrow.y + pts[0][1] };
    const last = { x: arrow.x + pts[pts.length - 1][0], y: arrow.y + pts[pts.length - 1][1] };
    const pointBox = (p: { x: number; y: number }) => ({ ...p, width: 0, height: 0, type: "point" });
    if (!start && !end) return arrow;
    const geo = connect(start ?? pointBox(first), end ?? pointBox(last), start ? 6 : 0, end ? 6 : 0);
    return { ...arrow, ...geo };
  };

  const refreshAttached = (shape: SceneElement) => {
    const label = boundText(shape);
    if (label) put(centerLabel(label, shape));
    for (const ref of shape.boundElements ?? []) {
      const arrow = live(ref.id);
      if (!arrow || !isLinear(arrow)) continue;
      const routed = reroute(arrow);
      put(routed);
      const arrowLabel = boundText(routed);
      if (arrowLabel) put(centerLabel(arrowLabel, routed));
    }
  };

  const setLabel = (container: SceneElement, text: string, props: ElementProps) => {
    const existing = boundText(container);
    if (text === "") {
      if (existing) {
        put({ ...existing, isDeleted: true });
        put(removeBoundRef(container, existing.id));
      }
      return;
    }
    const color = props.labelColor ?? existing?.strokeColor ?? props.strokeColor ?? container.strokeColor;
    const label = existing
      ? remeasureText({ ...existing, text, originalText: text, strokeColor: color,
          ...(props.fontSize ? { fontSize: props.fontSize } : {}),
          ...(props.fontFamily ? { fontFamily: props.fontFamily } : {}) })
      : createText({ text, x: 0, y: 0, fontSize: props.fontSize, fontFamily: props.fontFamily,
          containerId: container.id, strokeColor: color, groupIds: container.groupIds ?? [] });
    put(centerLabel(label, live(container.id) ?? container));
    put(addBoundRef(live(container.id) ?? container, { id: label.id, type: "text" }));
  };

  const bindArrow = (arrow: SceneElement, startId?: string | null, endId?: string | null) => {
    let next = arrow;
    for (const [side, id] of [["start", startId], ["end", endId]] as const) {
      if (id === undefined) continue;
      const key = side === "start" ? "startBinding" : "endBinding";
      const previous = live(next[key]?.elementId);
      if (previous) put(removeBoundRef(previous, next.id));
      if (id === null) {
        next = { ...next, [key]: null };
        continue;
      }
      const target = need(id);
      if (!BINDABLE_TYPES.has(target.type)) {
        throw new SceneOpError(`Arrows can only attach to shapes, images and embeds; "${id}" is a ${target.type}`);
      }
      next = { ...next, [key]: arrow.type === "arrow" ? binding(id) : null };
      put(addBoundRef(live(id)!, { id: next.id, type: "arrow" }));
    }
    return reroute(next);
  };

  // Put an element (and its label) into a frame, or take it out with null.
  const setFrame = (id: string, frameId: string | null) => {
    const el = need(id);
    if (frameId !== null) {
      const frame = need(frameId);
      if (frame.type !== "frame") throw new SceneOpError(`"${frameId}" is a ${frame.type}, not a frame`);
      if (el.type === "frame") throw new SceneOpError("Frames cannot be nested");
    }
    put({ ...el, frameId });
    const label = boundText(el);
    if (label) put({ ...label, frameId });
  };

  const add = (props: ElementProps & { type: string }) => {
    if (props.id && current.has(props.id)) throw new SceneOpError(`Element id "${props.id}" already exists`);
    const id = props.id;
    const base = { ...(id ? { id } : {}), ...pick(props) };
    let el: SceneElement;
    if (props.type === "text") {
      if (!props.text) throw new SceneOpError("Text elements need `text`");
      el = createText({ ...base, text: props.text, x: props.x ?? 0, y: props.y ?? 0,
        fontSize: props.fontSize, fontFamily: props.fontFamily, textAlign: props.textAlign });
      if (props.anchor === "center") el = { ...el, x: el.x - el.width / 2, y: el.y - el.height / 2 };
    } else if (props.type === "arrow" || props.type === "line") {
      el = createLinear(props.type, { ...base, x: props.x ?? 0, y: props.y ?? 0, points: props.points,
        width: props.width, height: props.height, roundness: roundnessFor(props.type, props.rounded) });
      put(el);
      if (props.startId || props.endId) el = bindArrow(el, props.startId, props.endId);
    } else if (props.type === "freedraw") {
      if (!props.points || props.points.length < 2) throw new SceneOpError("Free draw needs at least 2 `points`");
      el = createFreedraw({ ...base, x: props.x ?? 0, y: props.y ?? 0, points: props.points });
    } else if (props.type === "frame") {
      el = createFrame({ ...base, x: props.x ?? 0, y: props.y ?? 0, width: props.width ?? 800,
        height: props.height ?? 600, name: props.name ?? null });
    } else if (props.type === "image") {
      if (!props.fileId) throw new SceneOpError("Image elements need an `image` source");
      el = createImage({ ...base, fileId: props.fileId, x: props.x ?? 0, y: props.y ?? 0,
        width: props.width ?? 300, height: props.height ?? 300 });
    } else if (props.type === "embeddable") {
      if (!props.link) throw new SceneOpError("Embeds need a `link`");
      el = createEmbeddable({ ...base, link: props.link, x: props.x ?? 0, y: props.y ?? 0,
        ...(props.width ? { width: props.width } : {}), ...(props.height ? { height: props.height } : {}) });
    } else if (props.type === "rectangle" || props.type === "ellipse" || props.type === "diamond") {
      const width = props.width ?? 160;
      const height = props.height ?? 80;
      const centered = props.anchor === "center";
      el = createShape(props.type, { ...base, width, height,
        x: (props.x ?? 0) - (centered ? width / 2 : 0), y: (props.y ?? 0) - (centered ? height / 2 : 0),
        roundness: roundnessFor(props.type, props.rounded ?? props.type === "rectangle") });
    } else {
      throw new SceneOpError(`Unsupported element type "${props.type}"`);
    }
    put(el);
    created.push(el.id);
    if (props.label && el.type !== "text" && el.type !== "frame" && el.type !== "freedraw" && el.type !== "image") {
      setLabel(el, props.label, props);
    }
    if (props.frameId !== undefined) setFrame(el.id, props.frameId);
  };

  const update = (id: string, props: ElementProps) => {
    const prev = need(id);
    let el = { ...prev, ...pick(props) };
    if (el.type === "frame" && props.name !== undefined) el = { ...el, name: props.name };
    for (const key of ["x", "y", "width", "height"] as const) {
      if (props[key] !== undefined) el = { ...el, [key]: props[key] };
    }
    if (props.anchor === "center" && (props.x !== undefined || props.y !== undefined)) {
      el = { ...el, x: el.x - (props.x !== undefined ? el.width / 2 : 0), y: el.y - (props.y !== undefined ? el.height / 2 : 0) };
    }
    if (props.rounded !== undefined) el = { ...el, roundness: roundnessFor(el.type, props.rounded) };
    if (el.type === "text" && (props.text !== undefined || props.fontSize || props.fontFamily)) {
      el = remeasureText({ ...el, ...(props.text !== undefined ? { text: props.text, originalText: props.text } : {}),
        ...(props.fontSize ? { fontSize: props.fontSize } : {}), ...(props.fontFamily ? { fontFamily: props.fontFamily } : {}),
        ...(props.textAlign ? { textAlign: props.textAlign } : {}) });
      const container = live(el.containerId);
      if (container) el = centerLabel(el, container);
    }
    if ((isLinear(el) || el.type === "freedraw") && props.points) {
      el = { ...el, points: props.points, ...linearBox(props.points) };
    }
    put(el);
    if (props.frameId !== undefined) setFrame(id, props.frameId);
    // Moving a frame carries its contents along, as in the editor.
    if (el.type === "frame" && (el.x !== prev.x || el.y !== prev.y)) {
      const dx = el.x - prev.x;
      const dy = el.y - prev.y;
      const children = [...current.values()].filter((c) => !c.isDeleted && c.frameId === id);
      for (const child of children) put({ ...live(child.id)!, x: child.x + dx, y: child.y + dy });
      for (const child of children) {
        const moved = live(child.id)!;
        if (!isLinear(moved) && moved.type !== "text") refreshAttached(moved);
      }
      return;
    }
    if (isLinear(el) && (props.startId !== undefined || props.endId !== undefined)) {
      put(bindArrow(el, props.startId, props.endId));
    }
    if (props.label !== undefined && el.type !== "text") setLabel(live(id)!, props.label, props);
    if (!isLinear(el) && el.type !== "text") refreshAttached(live(id)!);
    else if (isLinear(el)) {
      const label = boundText(live(id)!);
      if (label) put(centerLabel(label, live(id)!));
    }
  };

  const remove = (id: string) => {
    const el = need(id);
    put({ ...el, isDeleted: true });
    if (el.type === "frame") {
      for (const child of [...current.values()]) {
        if (!child.isDeleted && child.frameId === id) put({ ...child, frameId: null });
      }
      return;
    }
    if (el.type === "text") {
      const container = live(el.containerId);
      if (container) put(removeBoundRef(container, el.id));
      return;
    }
    for (const ref of el.boundElements ?? []) {
      const other = live(ref.id);
      if (!other) continue;
      if (other.type === "text" && other.containerId === el.id) {
        put({ ...other, isDeleted: true });
      } else if (isLinear(other)) {
        const next = { ...other };
        if (next.startBinding?.elementId === el.id) next.startBinding = null;
        if (next.endBinding?.elementId === el.id) next.endBinding = null;
        put(next);
      }
    }
    for (const key of ["startBinding", "endBinding"] as const) {
      const target = live(el[key]?.elementId);
      if (target) put(removeBoundRef(target, el.id));
    }
  };

  for (const operation of operations) {
    if (operation.op === "add") add(operation.element);
    else if (operation.op === "update") targetIds(operation).forEach((id) => update(id, operation.set));
    else if (operation.op === "delete") {
      // Ids already removed earlier in the call (e.g. a label with its shape) are fine; unknown ids are not.
      for (const id of targetIds(operation)) {
        if (!current.has(id)) need(id);
        if (live(id)) remove(id);
      }
    }
    else if (operation.op === "assign_frame") {
      const frame = need(operation.frameId);
      if (frame.type !== "frame") throw new SceneOpError(`"${operation.frameId}" is a ${frame.type}, not a frame`);
      const ids = operation.ids
        ?? elementsWithin([...current.values()], operation.area ?? frame).filter((hit) => live(hit)?.type !== "frame");
      if (ids.length === 0) throw new SceneOpError("No elements to put in the frame");
      for (const id of ids) setFrame(id, frame.id);
    } else if (operation.op === "erase") {
      const hits = elementsInArea([...current.values()], operation).filter((hit) => live(hit));
      if (hits.length === 0) throw new SceneOpError("Nothing to erase in that area");
      for (const hit of hits) if (live(hit)) remove(hit);
    } else if (operation.op === "reorder") {
      operation.ids.forEach(need);
      order.splice(0, order.length, ...reorderIds(order, operation.ids, operation.to));
    }
  }
  const finalOrder = orderFramesAfterChildren(order, current);

  const before: TouchedState = {};
  const after: TouchedState = {};
  for (const id of touched) {
    const prev = original.get(id) ?? null;
    const next = current.get(id)!;
    const finalEl = prev ? bump(next, prev.version) : { ...next, version: 1 };
    if (!prev && finalEl.isDeleted) continue; // created and removed in one edit
    before[id] = prev;
    after[id] = finalEl;
    current.set(id, finalEl);
  }

  const keptOrder = finalOrder.filter((id) => original.has(id) || hasKey(after, id));
  const originalOrder = elements.map((el) => el.id);
  return {
    elements: keptOrder.map((id) => current.get(id)!),
    // Set when the stacking order changed, so it can be stored and broadcast.
    orderBefore: keptOrder.join("|") === [...originalOrder, ...keptOrder.filter((id) => !original.has(id))].join("|")
      ? null
      : originalOrder,
    order: keptOrder,
    before,
    after,
    created: created.filter((id) => after[id]),
    touchedOrder: touched.filter((id) => after[id]),
  };
};

const hasKey = (state: TouchedState, id: string) => Object.prototype.hasOwnProperty.call(state, id);
