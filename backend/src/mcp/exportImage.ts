import { Resvg } from "@resvg/resvg-js";
import type { PrismaClient } from "../generated/client";
import { generatePresignedDownloadUrl } from "../s3";
import type { SceneElement } from "./elements";
import { renderSceneSvg, selectForExport, type RenderOptions } from "./render";

// Exports a drawing (or one frame / some elements) as SVG or PNG. Image
// elements are inlined from the drawing's stored files.

const MAX_EXPORT_PIXELS = 4096;

const loadImages = async (
  prisma: PrismaClient,
  drawingId: string,
  elements: SceneElement[],
  files: Record<string, { dataURL?: string; mimeType?: string }>,
): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  const fileIds = [...new Set(elements.filter((el) => el.type === "image" && el.fileId).map((el) => el.fileId as string))];
  for (const fileId of fileIds) {
    const entry = files[fileId];
    if (entry?.dataURL?.startsWith("data:")) {
      out[fileId] = entry.dataURL;
      continue;
    }
    const row = await prisma.drawingFile.findUnique({ where: { drawingId_fileId: { drawingId, fileId } } });
    if (!row) continue;
    if (row.storage === "db" && row.data) {
      out[fileId] = `data:${row.mimeType};base64,${Buffer.from(row.data).toString("base64")}`;
    } else if (row.storage === "s3" && row.s3Key) {
      try {
        const res = await fetch(await generatePresignedDownloadUrl(row.s3Key), { signal: AbortSignal.timeout(10_000) });
        if (res.ok) out[fileId] = `data:${row.mimeType};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
      } catch {
        // Rendered as a placeholder box.
      }
    }
  }
  return out;
};

export const exportDrawing = async (args: {
  prisma: PrismaClient;
  drawingId: string;
  elements: SceneElement[];
  files: Record<string, { dataURL?: string; mimeType?: string }>;
  format: "png" | "svg";
  scale: number;
  options: RenderOptions;
}) => {
  const selected = selectForExport(args.elements, args.options);
  const images = await loadImages(args.prisma, args.drawingId, selected, args.files);
  const { svg, width, height, elementCount } = renderSceneSvg(args.elements, { ...args.options, images });
  if (args.format === "svg") return { format: "svg" as const, svg, width, height, elementCount };
  const scale = Math.min(args.scale, MAX_EXPORT_PIXELS / Math.max(width, height));
  const png = new Resvg(svg, {
    fitTo: { mode: "zoom", value: scale },
    font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" },
  }).render().asPng();
  return {
    format: "png" as const,
    png: Buffer.from(png),
    width: Math.round(width * scale),
    height: Math.round(height * scale),
    elementCount,
  };
};
