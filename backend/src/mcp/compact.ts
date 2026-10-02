import { FONT_FAMILIES, type SceneElement } from "./elements";
import { elementsInArea, type Area } from "./sceneExtras";

// A compact, model-friendly view of a scene: bound labels are folded into
// their containers, numbers are rounded, and style values shared by most
// elements are listed once in `styleDefaults` instead of on every element.

const BUILT_IN_STYLE: Record<string, unknown> = {
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  angle: 0,
};
// Style keys that are folded into styleDefaults when most elements share them.
const SHARED_KEYS = [...Object.keys(BUILT_IN_STYLE), "rounded", "font", "fontSize"];

const r = (n: unknown) => (typeof n === "number" ? Math.round(n * 10) / 10 : n);

export const compactElement = (el: SceneElement, labels: Map<string, SceneElement>) => {
  const out: Record<string, unknown> = { id: el.id, type: el.type, x: r(el.x), y: r(el.y), w: r(el.width), h: r(el.height) };
  if (el.type !== "frame") {
    for (const [key, value] of Object.entries(BUILT_IN_STYLE)) out[key] = r(el[key] ?? value);
  }
  if (el.type === "rectangle" || el.type === "diamond") out.rounded = Boolean(el.roundness);
  if (el.groupIds?.length) out.groupIds = el.groupIds;
  if (el.locked) out.locked = true;
  if (el.frameId) out.frameId = el.frameId;
  if (el.type === "frame") out.name = el.name ?? null;
  if (el.type === "image") out.fileId = el.fileId;
  if (el.type === "freedraw") out.pointCount = (el.points ?? []).length;
  if (el.link) out.link = el.link;
  if (el.type === "text") {
    out.text = el.text;
    out.fontSize = el.fontSize;
    out.font = FONT_FAMILIES[el.fontFamily]?.name ?? el.fontFamily;
    if (el.textAlign && el.textAlign !== "left") out.textAlign = el.textAlign;
  }
  const label = labels.get(el.id);
  if (label) {
    out.label = label.text;
    out.labelId = label.id;
    out.labelFontSize = label.fontSize;
    if (label.strokeColor !== el.strokeColor) out.labelColor = label.strokeColor;
  }
  if (el.type === "arrow" || el.type === "line") {
    out.points = (el.points ?? []).map((p: number[]) => [r(p[0]), r(p[1])]);
    if (el.startBinding?.elementId) out.startId = el.startBinding.elementId;
    if (el.endBinding?.elementId) out.endId = el.endBinding.elementId;
    if (el.startArrowhead) out.startArrowhead = el.startArrowhead;
    if (el.type === "arrow" && el.endArrowhead !== "arrow") out.endArrowhead = el.endArrowhead;
  }
  return out;
};

// Most common value per shared style key; elements then omit matching values.
const hoistStyleDefaults = (elements: Record<string, unknown>[]) => {
  const defaults: Record<string, unknown> = {};
  for (const key of SHARED_KEYS) {
    const counts = new Map<string, number>();
    for (const el of elements) {
      if (key in el) counts.set(JSON.stringify(el[key]), (counts.get(JSON.stringify(el[key])) ?? 0) + 1);
    }
    const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (!top) continue;
    defaults[key] = JSON.parse(top[0]);
    for (const el of elements) if (key in el && JSON.stringify(el[key]) === top[0]) delete el[key];
  }
  return defaults;
};

export type CompactOptions = {
  frameId?: string;
  area?: Area;
  ids?: string[];
  summaryOnly?: boolean;
  maxElements?: number;
};

export const compactScene = (elements: SceneElement[], options: CompactOptions = {}) => {
  const liveEls = elements.filter((el) => !el.isDeleted);
  const liveIds = new Set(liveEls.map((el) => el.id));
  const labels = new Map<string, SceneElement>();
  for (const el of liveEls) if (el.type === "text" && el.containerId) labels.set(el.containerId, el);
  const topLevel = liveEls.filter((el) => !(el.type === "text" && el.containerId && liveIds.has(el.containerId)));

  let visible = topLevel;
  if (options.frameId) visible = visible.filter((el) => el.id === options.frameId || el.frameId === options.frameId);
  if (options.area) {
    const hits = new Set(elementsInArea(visible, options.area));
    visible = visible.filter((el) => hits.has(el.id));
  }
  if (options.ids?.length) {
    const wanted = new Set(options.ids);
    visible = visible.filter((el) => wanted.has(el.id));
  }

  const bounds = visible.reduce(
    (b, el) => ({
      minX: Math.min(b.minX, el.x), minY: Math.min(b.minY, el.y),
      maxX: Math.max(b.maxX, el.x + el.width), maxY: Math.max(b.maxY, el.y + el.height),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  const frames = topLevel
    .filter((el) => el.type === "frame")
    .map((f) => ({
      id: f.id, name: f.name ?? null, x: r(f.x), y: r(f.y), w: r(f.width), h: r(f.height),
      elementCount: topLevel.filter((el) => el.frameId === f.id).length,
    }));
  const summary = {
    totalElements: topLevel.length,
    elementCount: visible.length,
    bounds: visible.length
      ? { x: r(bounds.minX), y: r(bounds.minY), width: r(bounds.maxX - bounds.minX), height: r(bounds.maxY - bounds.minY) }
      : null,
    frames,
  };
  if (options.summaryOnly) return summary;

  const max = options.maxElements ?? 1500;
  const compacted = visible.slice(0, max).map((el) => compactElement(el, labels));
  const styleDefaults = hoistStyleDefaults(compacted);
  return { ...summary, truncated: visible.length > max, styleDefaults, elements: compacted };
};
