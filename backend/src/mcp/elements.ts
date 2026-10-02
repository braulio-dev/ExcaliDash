import crypto from "crypto";

// Builders for Excalidraw (0.18) scene elements created by MCP agents. The
// server has no canvas, so text is measured with per-font width estimates;
// close enough that labels sit centred in their containers.

export type SceneElement = Record<string, any> & {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  isDeleted?: boolean;
};

export const SHAPE_TYPES = ["rectangle", "ellipse", "diamond"] as const;
export const LINEAR_TYPES = ["arrow", "line"] as const;
export const ELEMENT_TYPES = [...SHAPE_TYPES, ...LINEAR_TYPES, "text", "freedraw", "frame", "image", "embeddable"] as const;
// Elements an arrow may attach to.
export const BINDABLE_TYPES = new Set<string>([...SHAPE_TYPES, "image", "embeddable"]);
export type ElementType = (typeof ELEMENT_TYPES)[number];

// Excalidraw font ids → [line height, average glyph width factor].
export const FONT_FAMILIES: Record<number, { name: string; lineHeight: number; width: number }> = {
  1: { name: "Virgil", lineHeight: 1.25, width: 1.15 },
  2: { name: "Helvetica", lineHeight: 1.15, width: 1.0 },
  3: { name: "Cascadia", lineHeight: 1.2, width: 1.0 },
  5: { name: "Excalifont", lineHeight: 1.25, width: 1.12 },
  6: { name: "Nunito", lineHeight: 1.35, width: 1.05 },
  7: { name: "Lilita One", lineHeight: 1.15, width: 0.95 },
  8: { name: "Comic Shanns", lineHeight: 1.25, width: 1.0 },
};
export const DEFAULT_FONT_FAMILY = 5;
const MONOSPACE = new Set([3, 8]);

const glyphWidth = (ch: string): number => {
  if (ch === " ") return 0.28;
  if ("il.,:;'|!ijft()[]".includes(ch)) return 0.3;
  if ("mwMW@".includes(ch)) return 0.86;
  if (/[A-Z]/.test(ch)) return 0.67;
  if (/[0-9]/.test(ch)) return 0.56;
  return 0.53;
};

export const measureText = (text: string, fontSize: number, fontFamily: number) => {
  const font = FONT_FAMILIES[fontFamily] ?? FONT_FAMILIES[DEFAULT_FONT_FAMILY];
  const lines = text.split("\n");
  const widest = Math.max(
    ...lines.map((line) =>
      MONOSPACE.has(fontFamily)
        ? line.length * 0.6
        : [...line].reduce((sum, ch) => sum + glyphWidth(ch), 0) * font.width,
    ),
  );
  return {
    width: Math.max(1, widest * fontSize),
    height: lines.length * fontSize * font.lineHeight,
    lineHeight: font.lineHeight,
  };
};

const randomInt = () => crypto.randomInt(1, 2 ** 31 - 1);
export const newId = () => crypto.randomBytes(12).toString("base64url");

// Mark an element as changed so every client's version-based merge picks it up.
export const bump = <T extends SceneElement>(el: T, version?: number): T => ({
  ...el,
  version: (version ?? el.version ?? 0) + 1,
  versionNonce: randomInt(),
  updated: Date.now(),
});

const baseElement = (type: string, props: Record<string, any>): SceneElement => ({
  id: newId(),
  type,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  index: null,
  roundness: null,
  seed: randomInt(),
  version: 1,
  versionNonce: randomInt(),
  isDeleted: false,
  boundElements: null,
  updated: Date.now(),
  link: null,
  locked: false,
  ...props,
});

export const roundnessFor = (type: string, rounded: boolean | undefined) => {
  if (rounded === false) return null;
  if (type === "rectangle") return rounded ? { type: 3 } : null;
  if (type === "diamond") return rounded ? { type: 2 } : null;
  if (type === "arrow" || type === "line") return rounded ? { type: 2 } : null;
  return null;
};

export const createShape = (type: string, props: Record<string, any>) =>
  baseElement(type, props);

export const createText = (props: {
  text: string;
  x: number;
  y: number;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  containerId?: string | null;
  [key: string]: any;
}) => {
  const fontSize = props.fontSize ?? 20;
  const fontFamily = props.fontFamily ?? DEFAULT_FONT_FAMILY;
  const size = measureText(props.text, fontSize, fontFamily);
  return baseElement("text", {
    strokeWidth: 1,
    ...props,
    width: size.width,
    height: size.height,
    fontSize,
    fontFamily,
    text: props.text,
    originalText: props.text,
    textAlign: props.textAlign ?? (props.containerId ? "center" : "left"),
    verticalAlign: props.verticalAlign ?? (props.containerId ? "middle" : "top"),
    containerId: props.containerId ?? null,
    autoResize: true,
    lineHeight: size.lineHeight,
  });
};

export const createLinear = (type: "arrow" | "line", props: Record<string, any>) => {
  const points: [number, number][] = props.points ?? [[0, 0], [props.width ?? 100, props.height ?? 0]];
  return baseElement(type, {
    ...props,
    ...linearBox(points),
    points,
    lastCommittedPoint: null,
    startBinding: props.startBinding ?? null,
    endBinding: props.endBinding ?? null,
    startArrowhead: props.startArrowhead ?? null,
    endArrowhead: props.endArrowhead ?? (type === "arrow" ? "arrow" : null),
    ...(type === "arrow" ? { elbowed: false } : {}),
  });
};

export const createFreedraw = (props: Record<string, any> & { points: [number, number][] }) =>
  baseElement("freedraw", {
    ...props,
    ...linearBox(props.points),
    pressures: [],
    simulatePressure: true,
    lastCommittedPoint: null,
  });

// Frames use Excalidraw's frame defaults (thin grey outline, no fill).
export const createFrame = (props: Record<string, any>) =>
  baseElement("frame", {
    strokeColor: "#bbb",
    strokeWidth: 2,
    roughness: 0,
    ...props,
    name: props.name ?? null,
    backgroundColor: "transparent",
    roundness: null,
  });

export const createImage = (props: Record<string, any> & { fileId: string }) =>
  baseElement("image", {
    strokeColor: "transparent",
    ...props,
    backgroundColor: "transparent",
    status: "saved",
    scale: [1, 1],
    crop: null,
  });

export const createEmbeddable = (props: Record<string, any> & { link: string }) =>
  baseElement("embeddable", { width: 560, height: 315, roundness: { type: 3 }, ...props });

export const linearBox = (points: [number, number][]) => {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
};

// Place a bound label centred in its container (or on an arrow's midpoint).
export const centerLabel = (label: SceneElement, container: SceneElement): SceneElement => {
  let cx = container.x + container.width / 2;
  let cy = container.y + container.height / 2;
  if (container.type === "arrow" || container.type === "line") {
    const pts: [number, number][] = container.points ?? [[0, 0]];
    const mid = pts[Math.floor((pts.length - 1) / 2)];
    const next = pts[Math.min(pts.length - 1, Math.floor((pts.length - 1) / 2) + 1)];
    cx = container.x + (mid[0] + next[0]) / 2;
    cy = container.y + (mid[1] + next[1]) / 2;
  }
  return { ...label, x: cx - label.width / 2, y: cy - label.height / 2 };
};

export const remeasureText = (el: SceneElement): SceneElement => {
  const size = measureText(el.text ?? "", el.fontSize ?? 20, el.fontFamily ?? DEFAULT_FONT_FAMILY);
  return { ...el, width: size.width, height: size.height, lineHeight: size.lineHeight };
};

type Box = { x: number; y: number; width: number; height: number; type: string };

// Point where the ray from the box centre towards (tx, ty) leaves the shape,
// pushed outwards by `gap` so arrowheads do not overlap the outline.
const edgePoint = (box: Box, tx: number, ty: number, gap: number) => {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  const len = Math.hypot(dx, dy) || 1;
  const hw = box.width / 2;
  const hh = box.height / 2;
  let t: number;
  if (box.type === "ellipse") {
    t = 1 / Math.sqrt((dx * dx) / (hw * hw || 1) + (dy * dy) / (hh * hh || 1));
  } else if (box.type === "diamond") {
    t = 1 / (Math.abs(dx) / (hw || 1) + Math.abs(dy) / (hh || 1));
  } else {
    t = Math.min(hw / (Math.abs(dx) || 1e-9), hh / (Math.abs(dy) || 1e-9));
  }
  return { x: cx + dx * t + (dx / len) * gap, y: cy + dy * t + (dy / len) * gap };
};

// Straight connector between two shapes, expressed as Excalidraw arrow fields.
export const connect = (from: Box, to: Box, fromGap = 6, toGap = 6) => {
  const fc = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const tc = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const start = edgePoint(from, tc.x, tc.y, fromGap);
  const end = edgePoint(to, fc.x, fc.y, toGap);
  const points: [number, number][] = [[0, 0], [end.x - start.x, end.y - start.y]];
  return { x: start.x, y: start.y, points, ...linearBox(points) };
};

export const binding = (elementId: string) => ({ elementId, focus: 0, gap: 6 });

export const addBoundRef = (el: SceneElement, ref: { id: string; type: string }): SceneElement => {
  const existing: { id: string; type: string }[] = Array.isArray(el.boundElements) ? el.boundElements : [];
  if (existing.some((b) => b.id === ref.id)) return el;
  return { ...el, boundElements: [...existing, ref] };
};

export const removeBoundRef = (el: SceneElement, id: string): SceneElement => {
  if (!Array.isArray(el.boundElements)) return el;
  const next = el.boundElements.filter((b: { id: string }) => b.id !== id);
  return { ...el, boundElements: next.length ? next : null };
};
