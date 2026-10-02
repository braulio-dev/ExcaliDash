import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canEditDrawing, canViewDrawing, getDrawingAccess } from "../authz/sharing";
import { getUserTrashCollectionId } from "../routes/dashboard/trash";
import { applyAgentEdit, listAgentChanges, revertAgentChange, type ChangeDeps } from "./changes";
import { compactScene } from "./compact";
import { ELEMENT_TYPES, type SceneElement } from "./elements";
import { resolveImage } from "./images";
import type { SceneOperation } from "./sceneOps";
import { fail, guard, ok } from "./toolResult";
import { registerExtraTools } from "./toolsExtra";
import type { AgentIdentity } from "../server/agentPresence";

// Tool definitions for one MCP session. Every tool acts as the API key's user
// and goes through the same drawing access checks as the REST API.

export type ToolContext = ChangeDeps & {
  userId: string;
  publicUrl: string;
  getAgent: () => AgentIdentity;
  renameAgent: (name: string) => AgentIdentity;
  log: (action: string, details: Record<string, unknown>) => void;
};

const color = z.string().regex(/^(#[0-9a-fA-F]{3,8}|transparent)$/, "Use a hex colour like #1e1e1e or 'transparent'");
const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, "Ids may use letters, digits, - and _");
const arrowhead = z.enum(["arrow", "bar", "dot", "circle", "circle_outline", "triangle", "triangle_outline", "diamond", "diamond_outline"]).nullable();

const elementProps = z.object({
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  width: z.number().finite().positive().optional(),
  height: z.number().finite().positive().optional(),
  anchor: z.enum(["topLeft", "center"]).optional().describe("Whether x/y is the top-left corner (default) or the centre"),
  text: z.string().max(5000).optional().describe("Content of a text element"),
  label: z.string().max(2000).optional().describe("Text centred inside a shape or on an arrow; '' removes it"),
  labelColor: color.optional(),
  strokeColor: color.optional(),
  backgroundColor: color.optional(),
  fillStyle: z.enum(["solid", "hachure", "cross-hatch", "zigzag"]).optional(),
  strokeWidth: z.number().min(0.5).max(16).optional(),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  roughness: z.number().min(0).max(2).optional().describe("0 = clean lines, 1 = hand-drawn (default), 2 = sketchy"),
  opacity: z.number().min(0).max(100).optional(),
  rounded: z.boolean().optional(),
  fontSize: z.number().min(6).max(300).optional(),
  fontFamily: z.union([1, 2, 3, 5, 6, 7, 8].map((n) => z.literal(n)) as any).optional()
    .describe("1 Virgil, 2 Helvetica, 3 Cascadia, 5 Excalifont (default), 6 Nunito, 7 Lilita One, 8 Comic Shanns"),
  textAlign: z.enum(["left", "center", "right"]).optional(),
  groupIds: z.array(z.string().max(64)).max(20).optional(),
  points: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(2).max(2000).optional()
    .describe("Points relative to x/y for line, arrow and freedraw (pen strokes); arrows attached at both ends ignore them"),
  startId: id.nullable().optional().describe("Shape the arrow starts from (attached, follows the shape)"),
  endId: id.nullable().optional().describe("Shape the arrow points to"),
  startArrowhead: arrowhead.optional(),
  endArrowhead: arrowhead.optional(),
  angle: z.number().finite().optional().describe("Rotation in radians"),
  link: z.string().url().max(2000).nullable().optional().describe("Hyperlink on any element; the page shown by an embeddable"),
  locked: z.boolean().optional(),
  name: z.string().max(200).nullable().optional().describe("Frame title"),
  frameId: id.nullable().optional().describe("Frame this element belongs to (it is clipped to the frame and moves with it); null removes it"),
  image: z.object({
    url: z.string().url().max(2000).optional().describe("Public https image URL"),
    dataUrl: z.string().max(7_500_000).optional().describe("data:image/...;base64,..."),
  }).optional().describe("Image source for type 'image' (PNG, JPEG, GIF, WebP or SVG, up to 5 MB)"),
});

const areaSchema = z.object({
  x: z.number().finite(), y: z.number().finite(), width: z.number().finite().positive(), height: z.number().finite().positive(),
});

const operation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), element: elementProps.extend({ type: z.enum(ELEMENT_TYPES), id: id.optional() }) }),
  z.object({ op: z.literal("update"), id: id.optional(), ids: z.array(id).max(1000).optional(), set: elementProps })
    .describe("Change one element (`id`) or apply the same change to many (`ids`)"),
  z.object({ op: z.literal("delete"), id: id.optional(), ids: z.array(id).max(1000).optional() }),
  z.object({
    op: z.literal("assign_frame"),
    frameId: id,
    ids: z.array(id).max(1000).optional(),
    area: areaSchema.optional(),
  }).describe("Put elements in a frame: the listed `ids`, everything inside `area`, or by default everything inside the frame"),
  z.object({
    op: z.literal("erase"),
    x: z.number().finite(), y: z.number().finite(), width: z.number().finite().positive(), height: z.number().finite().positive(),
  }).describe("Eraser: delete every element touching this area"),
  z.object({ op: z.literal("reorder"), ids: z.array(id).min(1).max(400), to: z.enum(["front", "back"]) })
    .describe("Bring elements to the front or send them to the back"),
]);


export const registerTools = (server: McpServer, ctx: ToolContext) => {
  const access = (drawingId: string) =>
    getDrawingAccess({ prisma: ctx.prisma, principal: { kind: "user", userId: ctx.userId }, drawingId });
  const drawingUrl = (drawingId: string) => `${ctx.publicUrl}/editor/${drawingId}`;

  server.registerTool("list_drawings", {
    title: "List drawings",
    description: "List drawings you own or that are shared with you, most recently edited first.",
    inputSchema: { search: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true },
  }, ({ search, limit }) => guard(async () => {
    const drawings = await ctx.prisma.drawing.findMany({
      where: {
        AND: [
          { OR: [{ userId: ctx.userId }, { permissions: { some: { granteeUserId: ctx.userId, hidden: false } } }] },
          // Spelled out because NOT(collectionId = trash) also drops drawings with no collection (SQL NULL).
          { OR: [{ collectionId: null }, { collectionId: { not: getUserTrashCollectionId(ctx.userId) } }] },
        ],
        ...(search ? { name: { contains: search } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: limit ?? 30,
      select: { id: true, name: true, updatedAt: true, userId: true, collection: { select: { name: true } } },
    });
    return ok(drawings.map((d) => ({
      id: d.id, name: d.name, updatedAt: d.updatedAt, collection: d.collection?.name ?? null,
      shared: d.userId !== ctx.userId, url: drawingUrl(d.id),
    })));
  }));

  server.registerTool("read_drawing", {
    title: "Read drawing",
    description: [
      "Open a drawing (you appear in it as a live collaborator) and return its elements in compact form.",
      "Bound text is shown as `label` on its shape or arrow. Style values most elements share are listed once in `styleDefaults`; elements only show values that differ.",
      "`frames` always lists the drawing's frames. To save tokens, read just one `frame` (id or name), an `area`, or some `ids`, or use `summaryOnly` to get only counts and frames.",
      "Read before editing; after edit_drawing there is no need to read again unless you need new positions.",
    ].join(" "),
    inputSchema: {
      drawingId: z.string().min(1),
      frame: z.string().max(200).optional().describe("Only this frame (id or name) and its contents"),
      area: areaSchema.optional().describe("Only elements touching this area"),
      ids: z.array(z.string()).max(1000).optional().describe("Only these elements"),
      summaryOnly: z.boolean().optional().describe("Return counts, bounds and frames without elements"),
    },
    annotations: { readOnlyHint: true },
  }, ({ drawingId, frame, area, ids, summaryOnly }) => guard(async () => {
    const level = await access(drawingId);
    if (!canViewDrawing(level)) return fail("Drawing not found or you do not have access to it");
    const drawing = await ctx.prisma.drawing.findUnique({ where: { id: drawingId } });
    if (!drawing) return fail("Drawing not found");
    ctx.presence.join(drawingId, ctx.getAgent());
    const elements = ctx.parseJsonField<SceneElement[]>(drawing.elements, []);
    const appState = ctx.parseJsonField<Record<string, unknown>>(drawing.appState, {});
    let frameId: string | undefined;
    if (frame) {
      const match = elements.find((el) => !el.isDeleted && el.type === "frame" && (el.id === frame || el.name === frame));
      if (!match) return fail(`No frame with id or name "${frame}"`);
      frameId = match.id;
    }
    return ok({
      id: drawing.id, name: drawing.name, url: drawingUrl(drawing.id), access: level, version: drawing.version,
      background: appState.viewBackgroundColor ?? "#ffffff",
      ...compactScene(elements, { frameId, area, ids, summaryOnly }),
      recentAiChanges: (await listAgentChanges(ctx.prisma, drawingId, 5)).map((c) => ({
        changeId: c.id, by: c.agentName, summary: c.summary, at: c.createdAt, undone: Boolean(c.undoneAt),
      })),
    });
  }));

  server.registerTool("edit_drawing", {
    title: "Edit drawing",
    description: [
      "Apply operations to a drawing as one undoable change. People with the drawing open watch it happen live.",
      "Element types: rectangle, ellipse, diamond, text, arrow, line, freedraw (pen stroke from points), frame (named container), image (from `image.url` or `image.dataUrl`) and embeddable (web embed from `link`).",
      "Operations: add, update, delete, erase (everything touching an area) and reorder (front/back). `background` sets the canvas colour.",
      "Coordinates are canvas pixels, y grows downwards. New shapes default to 160x80; give `id`s to new elements so later operations in the same call (arrows via startId/endId, frameId) can reference them.",
      "To put a chart in a frame, add the frame first, then add or update elements with `frameId`; size the frame to enclose them (contents are clipped to it). Moving a frame moves its contents.",
      "Moving or resizing a shape keeps its label centred and re-routes attached arrows. Deleting a shape deletes its label.",
      "Bulk: `update`/`delete` take `ids` to apply one change to many elements; `assign_frame` fills a frame by ids or area.",
      "Returns a changeId for undo_change and the ids it created; no need to read the drawing again afterwards. Use export_drawing to look at the result.",
    ].join(" "),
    inputSchema: {
      drawingId: z.string().min(1),
      summary: z.string().min(1).max(300).describe("Short description of the change, shown in the editor's AI changes list"),
      operations: z.array(operation).max(400).default([]),
      background: color.optional().describe("Canvas background colour"),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  }, ({ drawingId, summary, operations, background }) => guard(async () => {
    if (!canEditDrawing(await access(drawingId))) return fail("You do not have edit access to this drawing");
    if (operations.length === 0 && !background) return fail("Give at least one operation or a background colour");
    // Store images first; the operations then reference them by file id.
    const files: Record<string, unknown> = {};
    for (const operation of operations) {
      if (operation.op !== "add" || operation.element.type !== "image") continue;
      if (!operation.element.image) return fail("Image elements need `image.url` or `image.dataUrl`");
      const resolved = await resolveImage(operation.element.image);
      files[resolved.fileId] = resolved.file;
      const el = operation.element as Record<string, unknown>;
      el.fileId = resolved.fileId;
      // Default to the natural size, scaled down to at most 800px wide.
      const ratio = resolved.height / resolved.width;
      const width = (el.width as number | undefined) ?? Math.min(resolved.width, 800);
      el.width = width;
      el.height = (el.height as number | undefined) ?? Math.round(width * ratio);
    }
    const result = await applyAgentEdit(ctx, {
      drawingId, userId: ctx.userId, agent: ctx.getAgent(), summary, operations: operations as SceneOperation[],
      files, background,
    });
    ctx.log("mcp_edit", { drawingId, changeId: result.changeId, elements: result.touched.length });
    return ok({ changeId: result.changeId, createdIds: result.created, changedElements: result.touched.length, version: result.version });
  }));

  const latestChange = async (drawingId: string, undone: boolean) =>
    ctx.prisma.agentChange.findFirst({
      where: { drawingId, sessionId: ctx.getAgent().sessionId, undoneAt: undone ? { not: null } : null },
      orderBy: undone ? { undoneAt: "desc" } : { createdAt: "desc" },
    });

  for (const direction of ["undo", "redo"] as const) {
    server.registerTool(`${direction}_change`, {
      title: direction === "undo" ? "Undo AI change" : "Redo AI change",
      description: direction === "undo"
        ? "Revert an AI change on a drawing. Without changeId, reverts this session's most recent change. Elements someone edited since are left alone and listed as skipped."
        : "Re-apply an undone AI change. Without changeId, redoes this session's most recently undone change.",
      inputSchema: { drawingId: z.string().min(1), changeId: z.string().optional() },
    }, ({ drawingId, changeId }) => guard(async () => {
      if (!canEditDrawing(await access(drawingId))) return fail("You do not have edit access to this drawing");
      const targetId = changeId ?? (await latestChange(drawingId, direction === "redo"))?.id;
      if (!targetId) return fail(`No change of yours to ${direction} on this drawing`);
      const result = await revertAgentChange(ctx, { drawingId, changeId: targetId, direction, agent: ctx.getAgent() });
      ctx.log(`mcp_${direction}`, { drawingId, changeId: targetId });
      return ok(result);
    }));
  }

  server.registerTool("list_changes", {
    title: "List AI changes",
    description: "List AI changes on a drawing (newest first), from any agent, with undo state.",
    inputSchema: { drawingId: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true },
  }, ({ drawingId, limit }) => guard(async () => {
    if (!canViewDrawing(await access(drawingId))) return fail("Drawing not found or you do not have access to it");
    const me = ctx.getAgent().sessionId;
    return ok((await listAgentChanges(ctx.prisma, drawingId, limit ?? 20)).map((c) => ({
      changeId: c.id, by: c.agentName, mine: c.sessionId === me, summary: c.summary,
      elements: c.elementCount, at: c.createdAt, undone: Boolean(c.undoneAt),
    })));
  }));

  server.registerTool("create_drawing", {
    title: "Create drawing",
    description: "Create a new, empty drawing owned by you.",
    inputSchema: { name: z.string().min(1).max(200) },
  }, ({ name }) => guard(async () => {
    const drawing = await ctx.prisma.drawing.create({
      data: { name, elements: "[]", appState: JSON.stringify({ viewBackgroundColor: "#ffffff" }), userId: ctx.userId },
    });
    ctx.invalidateDrawingsCache();
    ctx.log("mcp_create_drawing", { drawingId: drawing.id });
    return ok({ id: drawing.id, name: drawing.name, url: drawingUrl(drawing.id) });
  }));

  server.registerTool("set_agent_name", {
    title: "Set collaborator name",
    description: "Change the name you appear under as a live collaborator (e.g. to tell several AI sessions apart).",
    inputSchema: { name: z.string().min(1).max(60) },
  }, ({ name }) => guard(async () => ok(ctx.renameAgent(name))));

  registerExtraTools(server, { ...ctx, access, drawingUrl });
};
