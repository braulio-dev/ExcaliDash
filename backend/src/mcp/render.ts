import rough from "roughjs";
import type { Options } from "roughjs/bin/core";
import type { SceneElement } from "./elements";

// Server-side SVG rendering of a scene for export. It uses roughjs with each
// element's seed, so shapes get the same hand-drawn look as in the editor;
// fonts fall back to the system sans/mono fonts.

export type RenderOptions = {
  background?: string | null;
  padding?: number;
  // Restrict to one frame (rendered at its exact bounds) or a set of ids.
  frameId?: string;
  elementIds?: string[];
  // fileId -> data URL for image elements.
  images?: Record<string, string>;
};

const generator = rough.generator();

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n: number) => Math.round(n * 100) / 100;

const fontStack = (family: number) =>
  family === 3 || family === 8 ? "DejaVu Sans Mono, Consolas, monospace" : "DejaVu Sans, Arial, Helvetica, sans-serif";

const roughOptions = (el: SceneElement): Options => {
  const strokeWidth = el.strokeWidth ?? 2;
  const dashed = el.strokeStyle === "dashed" ? [8, 8 + strokeWidth] : el.strokeStyle === "dotted" ? [1.5, 6 + strokeWidth] : undefined;
  const filled = el.backgroundColor && el.backgroundColor !== "transparent";
  return {
    seed: el.seed ?? 1,
    roughness: el.roughness ?? 1,
    stroke: el.strokeColor === "transparent" ? "none" : el.strokeColor ?? "#1e1e1e",
    strokeWidth,
    ...(dashed ? { strokeLineDash: dashed, disableMultiStroke: true } : {}),
    ...(filled ? { fill: el.backgroundColor, fillStyle: el.fillStyle ?? "solid", fillWeight: strokeWidth / 2, hachureGap: strokeWidth * 4 } : {}),
    preserveVertices: (el.roughness ?? 1) < 2,
  };
};

const pathsToSvg = (drawable: ReturnType<typeof generator.rectangle>) =>
  generator
    .toPaths(drawable)
    .map((p) => `<path d="${p.d}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" fill="${p.fill ?? "none"}"${
      drawable.options.strokeLineDash ? ` stroke-dasharray="${drawable.options.strokeLineDash.join(" ")}"` : ""}/>`)
    .join("");

// Excalidraw's adaptive corner radius.
const cornerRadius = (size: number) => (size <= 128 ? size * 0.25 : 32);

const roundedRectPath = (x: number, y: number, w: number, h: number) => {
  const r = Math.min(cornerRadius(Math.min(w, h)), w / 2, h / 2);
  return `M ${x + r} ${y} L ${x + w - r} ${y} Q ${x + w} ${y} ${x + w} ${y + r} L ${x + w} ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} L ${x + r} ${y + h} Q ${x} ${y + h} ${x} ${y + h - r} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y}`;
};

const arrowhead = (el: SceneElement, kind: string, tip: number[], from: number[]): string => {
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const size = Math.min(30, Math.hypot(tip[0] - from[0], tip[1] - from[1]) * 0.6) || 10;
  const at = (a: number, d: number) => [tip[0] - d * Math.cos(angle + a), tip[1] - d * Math.sin(angle + a)];
  const opts = { ...roughOptions(el), strokeLineDash: undefined, disableMultiStroke: true };
  if (kind === "dot" || kind === "circle" || kind === "circle_outline") {
    const c = at(0, size / 4);
    return pathsToSvg(generator.circle(c[0], c[1], size / 2, { ...opts, fill: kind === "circle_outline" ? "#fff" : opts.stroke, fillStyle: "solid" }));
  }
  if (kind === "bar") {
    const across = (side: number) => [tip[0] + side * (size / 3) * Math.sin(angle), tip[1] - side * (size / 3) * Math.cos(angle)];
    return pathsToSvg(generator.linearPath([across(1), across(-1)] as [number, number][], opts));
  }
  if (kind.startsWith("triangle") || kind.startsWith("diamond")) {
    const pts = kind.startsWith("diamond")
      ? [tip, at(0.4, size / 1.6), at(0, size), at(-0.4, size / 1.6)]
      : [tip, at(0.45, size), at(-0.45, size)];
    const fill = kind.endsWith("outline") ? "#fff" : opts.stroke;
    return pathsToSvg(generator.polygon(pts as [number, number][], { ...opts, fill, fillStyle: "solid" }));
  }
  return pathsToSvg(generator.linearPath([at(0.45, size), tip, at(-0.45, size)] as [number, number][], opts));
};

const textSvg = (el: SceneElement) => {
  const fontSize = el.fontSize ?? 20;
  const lineHeight = (el.lineHeight ?? 1.25) * fontSize;
  const lines = String(el.text ?? "").split("\n");
  const anchor = el.textAlign === "center" ? "middle" : el.textAlign === "right" ? "end" : "start";
  const x = el.textAlign === "center" ? el.x + el.width / 2 : el.textAlign === "right" ? el.x + el.width : el.x;
  const baseline = el.y + (lineHeight - fontSize) / 2 + fontSize * 0.82;
  const spans = lines.map((line, i) => `<tspan x="${num(x)}" y="${num(baseline + i * lineHeight)}">${esc(line) || " "}</tspan>`).join("");
  return `<text font-family="${fontStack(el.fontFamily ?? 5)}" font-size="${fontSize}" fill="${el.strokeColor ?? "#1e1e1e"}" text-anchor="${anchor}" xml:space="preserve">${spans}</text>`;
};

const freedrawSvg = (el: SceneElement) => {
  const pts: number[][] = el.points ?? [];
  if (pts.length < 2) return "";
  let d = `M ${num(el.x + pts[0][0])} ${num(el.y + pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q ${num(el.x + pts[i][0])} ${num(el.y + pts[i][1])} ${num(el.x + mx)} ${num(el.y + my)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${num(el.x + last[0])} ${num(el.y + last[1])}`;
  return `<path d="${d}" fill="none" stroke="${el.strokeColor ?? "#1e1e1e"}" stroke-width="${(el.strokeWidth ?? 2) * 2}" stroke-linecap="round" stroke-linejoin="round"/>`;
};

const elementSvg = (el: SceneElement, images: Record<string, string>): string => {
  const { x, y, width: w, height: h } = el;
  const opts = roughOptions(el);
  switch (el.type) {
    case "rectangle":
      return pathsToSvg(el.roundness ? generator.path(roundedRectPath(x, y, w, h), opts) : generator.rectangle(x, y, w, h, opts));
    case "ellipse":
      return pathsToSvg(generator.ellipse(x + w / 2, y + h / 2, w, h, opts));
    case "diamond":
      return pathsToSvg(generator.polygon([[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]], opts));
    case "line":
    case "arrow": {
      const pts = (el.points ?? []).map((p: number[]) => [x + p[0], y + p[1]] as [number, number]);
      if (pts.length < 2) return "";
      const body = el.roundness && pts.length > 2 ? generator.curve(pts, opts) : generator.linearPath(pts, opts);
      let out = pathsToSvg(body);
      if (el.endArrowhead) out += arrowhead(el, el.endArrowhead, pts[pts.length - 1], pts[pts.length - 2]);
      if (el.startArrowhead) out += arrowhead(el, el.startArrowhead, pts[0], pts[1]);
      return out;
    }
    case "text":
      return textSvg(el);
    case "freedraw":
      return freedrawSvg(el);
    case "image": {
      const href = images[el.fileId];
      if (!href) return pathsToSvg(generator.rectangle(x, y, w, h, { ...opts, stroke: "#bbb", strokeLineDash: [6, 6] }));
      return `<image href="${esc(href)}" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" preserveAspectRatio="none"/>`;
    }
    case "embeddable":
      return pathsToSvg(generator.path(roundedRectPath(x, y, w, h), { ...opts, fill: "#f1f3f5", fillStyle: "solid" }))
        + textSvg({ ...el, type: "text", text: el.link ?? "embed", fontSize: 14, fontFamily: 2, textAlign: "center", strokeColor: "#868e96", y: y + h / 2 - 10, lineHeight: 1.25 } as SceneElement);
    case "frame":
      return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="8" fill="none" stroke="${el.strokeColor ?? "#bbb"}" stroke-width="2"/>`
        + `<text x="${num(x)}" y="${num(y - 8)}" font-family="${fontStack(2)}" font-size="14" fill="#868e96">${esc(el.name ?? "Frame")}</text>`;
    default:
      return "";
  }
};

const boundsOf = (el: SceneElement) => {
  if (Array.isArray(el.points) && el.points.length) {
    const xs = el.points.map((p: number[]) => el.x + p[0]);
    const ys = el.points.map((p: number[]) => el.y + p[1]);
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  }
  return { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height };
};

export const selectForExport = (elements: SceneElement[], options: RenderOptions): SceneElement[] => {
  const live = elements.filter((el) => !el.isDeleted);
  if (options.frameId) return live.filter((el) => el.id === options.frameId || el.frameId === options.frameId);
  if (options.elementIds?.length) {
    const ids = new Set(options.elementIds);
    return live.filter((el) => ids.has(el.id) || (el.containerId && ids.has(el.containerId)) || (el.frameId && ids.has(el.frameId)));
  }
  return live;
};

export const renderSceneSvg = (elements: SceneElement[], options: RenderOptions = {}) => {
  const selected = selectForExport(elements, options);
  if (selected.length === 0) throw new Error("Nothing to export");
  const frame = options.frameId ? selected.find((el) => el.id === options.frameId) : undefined;
  const pad = frame ? 0 : options.padding ?? 24;
  const b = frame
    ? { minX: frame.x, minY: frame.y, maxX: frame.x + frame.width, maxY: frame.y + frame.height }
    : selected.map(boundsOf).reduce((a, c) => ({
        minX: Math.min(a.minX, c.minX), minY: Math.min(a.minY, c.minY), maxX: Math.max(a.maxX, c.maxX), maxY: Math.max(a.maxY, c.maxY),
      }));
  // Frame titles sit above the frame; leave room for them in full exports.
  const top = !frame && selected.some((el) => el.type === "frame") ? 24 : 0;
  const width = Math.ceil(b.maxX - b.minX + pad * 2);
  const height = Math.ceil(b.maxY - b.minY + pad * 2 + top);
  const frames = new Map(selected.filter((el) => el.type === "frame").map((f) => [f.id, f]));
  const clips = [...frames.values()]
    .map((f) => `<clipPath id="clip-${esc(f.id)}"><rect x="${num(f.x)}" y="${num(f.y)}" width="${num(f.width)}" height="${num(f.height)}" rx="8"/></clipPath>`)
    .join("");
  const body = selected
    .filter((el) => !(frame && el.id === frame.id))
    .map((el) => {
      let svg = elementSvg(el, options.images ?? {});
      if (!svg) return "";
      if (el.angle) svg = `<g transform="rotate(${num((el.angle * 180) / Math.PI)} ${num(el.x + el.width / 2)} ${num(el.y + el.height / 2)})">${svg}</g>`;
      if ((el.opacity ?? 100) < 100) svg = `<g opacity="${(el.opacity ?? 100) / 100}">${svg}</g>`;
      if (el.frameId && frames.has(el.frameId)) svg = `<g clip-path="url(#clip-${esc(el.frameId)})">${svg}</g>`;
      return svg;
    })
    .join("");
  const bg = options.background ? `<rect x="0" y="0" width="${width}" height="${height}" fill="${esc(options.background)}"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<defs>${clips}</defs>${bg}<g transform="translate(${num(pad - b.minX)} ${num(pad + top - b.minY)})">${body}</g></svg>`;
  return { svg, width, height, elementCount: selected.length };
};
