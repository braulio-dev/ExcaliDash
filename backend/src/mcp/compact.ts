import { FONT_FAMILIES, type SceneElement } from "./elements";

// A compact, model-friendly view of a scene: bound labels are folded into
// their containers, defaults are omitted and numbers are rounded.

const DEFAULTS: Record<string, unknown> = {
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  angle: 0,
};

const r = (n: unknown) => (typeof n === "number" ? Math.round(n * 10) / 10 : n);

export const compactElement = (el: SceneElement, labels: Map<string, SceneElement>) => {
  const out: Record<string, unknown> = {
    id: el.id,
    type: el.type,
    x: r(el.x),
    y: r(el.y),
    w: r(el.width),
    h: r(el.height),
  };
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (el[key] !== undefined && el[key] !== value) out[key] = r(el[key]);
  }
  if (el.roundness) out.rounded = true;
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

export const compactScene = (elements: SceneElement[], maxElements = 1500) => {
  const liveEls = elements.filter((el) => !el.isDeleted);
  const labels = new Map<string, SceneElement>();
  for (const el of liveEls) {
    if (el.type === "text" && el.containerId) labels.set(el.containerId, el);
  }
  const visible = liveEls.filter(
    (el) => !(el.type === "text" && el.containerId && liveEls.some((c) => c.id === el.containerId)),
  );
  const bounds = visible.reduce(
    (b, el) => ({
      minX: Math.min(b.minX, el.x),
      minY: Math.min(b.minY, el.y),
      maxX: Math.max(b.maxX, el.x + el.width),
      maxY: Math.max(b.maxY, el.y + el.height),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  return {
    elementCount: visible.length,
    bounds: visible.length
      ? { x: r(bounds.minX), y: r(bounds.minY), width: r(bounds.maxX - bounds.minX), height: r(bounds.maxY - bounds.minY) }
      : null,
    truncated: visible.length > maxElements,
    elements: visible.slice(0, maxElements).map((el) => compactElement(el, labels)),
  };
};
