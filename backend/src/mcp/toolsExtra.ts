import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canEditDrawing, canViewDrawing, type DrawingAccess } from "../authz/sharing";
import type { SceneElement } from "./elements";
import { exportDrawing } from "./exportImage";
import { fail, guard, ok } from "./toolResult";
import type { ToolContext } from "./tools";

// Export, pointing and renaming. Kept apart from the editing tools in tools.ts.

type ExtraContext = ToolContext & {
  access: (drawingId: string) => Promise<DrawingAccess>;
  drawingUrl: (drawingId: string) => string;
};

export const registerExtraTools = (server: McpServer, ctx: ExtraContext) => {
  const loadScene = async (drawingId: string) => {
    const drawing = await ctx.prisma.drawing.findUnique({ where: { id: drawingId } });
    if (!drawing) return null;
    return {
      drawing,
      elements: ctx.parseJsonField<SceneElement[]>(drawing.elements, []),
      appState: ctx.parseJsonField<Record<string, unknown>>(drawing.appState, {}),
      files: ctx.parseJsonField<Record<string, { dataURL?: string; mimeType?: string }>>(drawing.files, {}),
    };
  };

  server.registerTool("export_drawing", {
    title: "Export drawing as image",
    description: [
      "Render a drawing, one frame, or some elements to PNG (returned as an image you can look at) or SVG.",
      "Use it to check your work after editing. The hand-drawn style matches the editor; text uses a standard sans font.",
    ].join(" "),
    inputSchema: {
      drawingId: z.string().min(1),
      format: z.enum(["png", "svg"]).default("png"),
      frame: z.string().max(200).optional().describe("Frame id or frame name to export on its own"),
      elementIds: z.array(z.string()).max(1000).optional().describe("Export only these elements (frames include their contents)"),
      scale: z.number().min(0.25).max(4).default(1),
      background: z.boolean().default(true).describe("Include the canvas background colour"),
    },
    annotations: { readOnlyHint: true },
  }, ({ drawingId, format, frame, elementIds, scale, background }) => guard(async () => {
    if (!canViewDrawing(await ctx.access(drawingId))) return fail("Drawing not found or you do not have access to it");
    const scene = await loadScene(drawingId);
    if (!scene) return fail("Drawing not found");
    let frameId: string | undefined;
    if (frame) {
      const match = scene.elements.find((el) => !el.isDeleted && el.type === "frame" && (el.id === frame || el.name === frame));
      if (!match) return fail(`No frame with id or name "${frame}"`);
      frameId = match.id;
    }
    const result = await exportDrawing({
      prisma: ctx.prisma,
      drawingId,
      elements: scene.elements,
      files: scene.files,
      format,
      scale,
      options: { frameId, elementIds, background: background ? String(scene.appState.viewBackgroundColor ?? "#ffffff") : null },
    }).catch((error: Error) => {
      if (error.message === "Nothing to export") return null;
      throw error;
    });
    if (!result) return fail("Nothing to export: the drawing or selection is empty");
    ctx.log("mcp_export", { drawingId, format, frameId });
    const caption = `${scene.drawing.name}${frameId ? ` (frame ${frame})` : ""}: ${result.width}x${result.height}px, ${result.elementCount} elements`;
    if (result.format === "svg") return { content: [{ type: "text" as const, text: `${caption}\n\n${result.svg}` }] };
    return {
      content: [
        { type: "image" as const, data: result.png.toString("base64"), mimeType: "image/png" },
        { type: "text" as const, text: caption },
      ],
    };
  }));

  server.registerTool("point_at", {
    title: "Point at elements",
    description: "Move your live cursor to elements (highlighting them) or to a point, like a laser pointer, so people watching the drawing see what you mean.",
    inputSchema: {
      drawingId: z.string().min(1),
      elementIds: z.array(z.string()).max(100).optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
    },
    annotations: { readOnlyHint: true },
  }, ({ drawingId, elementIds, x, y }) => guard(async () => {
    if (!canViewDrawing(await ctx.access(drawingId))) return fail("Drawing not found or you do not have access to it");
    let pointer = x !== undefined && y !== undefined ? { x, y } : null;
    if (!pointer && elementIds?.length) {
      const scene = await loadScene(drawingId);
      const targets = (scene?.elements ?? []).filter((el) => elementIds.includes(el.id) && !el.isDeleted);
      if (targets.length === 0) return fail("None of those elements exist");
      pointer = {
        x: targets.reduce((sum, el) => sum + el.x + el.width / 2, 0) / targets.length,
        y: targets.reduce((sum, el) => sum + el.y + el.height / 2, 0) / targets.length,
      };
    }
    if (!pointer) return fail("Give elementIds or x and y");
    ctx.presence.moveCursor(drawingId, ctx.getAgent(), pointer, elementIds ?? []);
    return ok({ pointer, highlighted: elementIds ?? [] });
  }));

  server.registerTool("rename_drawing", {
    title: "Rename drawing",
    description: "Rename a drawing you can edit.",
    inputSchema: { drawingId: z.string().min(1), name: z.string().min(1).max(200) },
  }, ({ drawingId, name }) => guard(async () => {
    if (!canEditDrawing(await ctx.access(drawingId))) return fail("You do not have edit access to this drawing");
    await ctx.prisma.drawing.update({ where: { id: drawingId }, data: { name } });
    ctx.invalidateDrawingsCache();
    ctx.log("mcp_rename_drawing", { drawingId });
    return ok({ id: drawingId, name, url: ctx.drawingUrl(drawingId) });
  }));
};
