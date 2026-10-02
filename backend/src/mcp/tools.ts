import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canEditDrawing, canViewDrawing, getDrawingAccess } from "../authz/sharing";
import { getUserTrashCollectionId } from "../routes/dashboard/trash";
import { applyAgentEdit, ChangeError, listAgentChanges, revertAgentChange, type ChangeDeps } from "./changes";
import { compactScene } from "./compact";
import { ELEMENT_TYPES, type SceneElement } from "./elements";
import { SceneOpError, type SceneOperation } from "./sceneOps";
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
  points: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(2).max(200).optional()
    .describe("Arrow/line points relative to x/y; ignored when both ends attach to shapes"),
  startId: id.nullable().optional().describe("Shape the arrow starts from (attached, follows the shape)"),
  endId: id.nullable().optional().describe("Shape the arrow points to"),
  startArrowhead: arrowhead.optional(),
  endArrowhead: arrowhead.optional(),
  angle: z.number().finite().optional().describe("Rotation in radians"),
  link: z.string().url().max(2000).nullable().optional(),
  locked: z.boolean().optional(),
});

const operation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), element: elementProps.extend({ type: z.enum(ELEMENT_TYPES), id: id.optional() }) }),
  z.object({ op: z.literal("update"), id, set: elementProps }),
  z.object({ op: z.literal("delete"), id }),
]);

const ok = (payload: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload, null, 1) }] });
const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

const guard = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SceneOpError || error instanceof ChangeError) return fail(error.message) as any;
    console.error("[mcp] tool failed:", error);
    return fail("The tool failed on the server. Re-read the drawing and try again.") as any;
  }
};

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
        OR: [{ userId: ctx.userId }, { permissions: { some: { granteeUserId: ctx.userId, hidden: false } } }],
        NOT: { collectionId: getUserTrashCollectionId(ctx.userId) },
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
    description: "Open a drawing (you appear in it as a live collaborator) and return its elements in compact form. Bound text is shown as `label` on its shape or arrow. Read before editing.",
    inputSchema: { drawingId: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, ({ drawingId }) => guard(async () => {
    const level = await access(drawingId);
    if (!canViewDrawing(level)) return fail("Drawing not found or you do not have access to it");
    const drawing = await ctx.prisma.drawing.findUnique({ where: { id: drawingId } });
    if (!drawing) return fail("Drawing not found");
    ctx.presence.join(drawingId, ctx.getAgent());
    const elements = ctx.parseJsonField<SceneElement[]>(drawing.elements, []);
    const appState = ctx.parseJsonField<Record<string, unknown>>(drawing.appState, {});
    return ok({
      id: drawing.id, name: drawing.name, url: drawingUrl(drawing.id), access: level, version: drawing.version,
      background: appState.viewBackgroundColor ?? "#ffffff",
      ...compactScene(elements),
      recentAiChanges: (await listAgentChanges(ctx.prisma, drawingId, 5)).map((c) => ({
        changeId: c.id, by: c.agentName, summary: c.summary, at: c.createdAt, undone: Boolean(c.undoneAt),
      })),
    });
  }));

  server.registerTool("edit_drawing", {
    title: "Edit drawing",
    description: [
      "Apply add/update/delete operations to a drawing as one undoable change. People with the drawing open watch it happen live.",
      "Coordinates are canvas pixels, y grows downwards. New shapes default to 160x80; give `id`s to new elements so later operations in the same call (e.g. arrows via startId/endId) can reference them.",
      "Moving or resizing a shape keeps its label centred and re-routes attached arrows. Deleting a shape deletes its label.",
      "Returns a changeId for undo_change.",
    ].join(" "),
    inputSchema: {
      drawingId: z.string().min(1),
      summary: z.string().min(1).max(300).describe("Short description of the change, shown in the editor's AI changes list"),
      operations: z.array(operation).min(1).max(400),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  }, ({ drawingId, summary, operations }) => guard(async () => {
    if (!canEditDrawing(await access(drawingId))) return fail("You do not have edit access to this drawing");
    const result = await applyAgentEdit(ctx, {
      drawingId, userId: ctx.userId, agent: ctx.getAgent(), summary, operations: operations as SceneOperation[],
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
};
