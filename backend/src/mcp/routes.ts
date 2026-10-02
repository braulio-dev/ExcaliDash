import type express from "express";
import { z } from "zod";
import type { PrismaClient } from "../generated/client";
import { canEditDrawing, canViewDrawing, getDrawingAccess } from "../authz/sharing";
import { logAuditEvent } from "../utils/audit";
import type { AgentPresence } from "../server/agentPresence";
import { ChangeError, listAgentChanges, revertAgentChange } from "./changes";
import { createMcpEndpoint } from "./server";

type Handler = (req: express.Request, res: express.Response, next: express.NextFunction) => unknown;

export type RegisterMcpDeps = {
  prisma: PrismaClient;
  presence: AgentPresence;
  requireAuth: Handler;
  asyncHandler: (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => Handler;
  parseJsonField: <T>(raw: string | null | undefined, fallback: T) => T;
  invalidateDrawingsCache: () => void;
  frontendUrl?: string;
};

const ENABLED_CACHE_MS = 5000;

export const registerMcpRoutes = (app: express.Express, deps: RegisterMcpDeps) => {
  const { prisma, requireAuth, asyncHandler } = deps;
  const publicUrl = (deps.frontendUrl?.split(",")[0]?.trim() || "http://localhost:6767").replace(/\/+$/, "");

  let enabledCache: { value: boolean; at: number } | null = null;
  const isEnabled = async () => {
    if (enabledCache && Date.now() - enabledCache.at < ENABLED_CACHE_MS) return enabledCache.value;
    const row = await prisma.systemConfig.findUnique({ where: { id: "default" }, select: { mcpEnabled: true } });
    enabledCache = { value: row?.mcpEnabled ?? true, at: Date.now() };
    return enabledCache.value;
  };

  const changeDeps = {
    prisma,
    presence: deps.presence,
    parseJsonField: deps.parseJsonField,
    invalidateDrawingsCache: deps.invalidateDrawingsCache,
  };
  const endpoint = createMcpEndpoint({ ...changeDeps, publicUrl, isEnabled });

  app.all("/mcp", requireAuth, asyncHandler(async (req, res) => endpoint.handle(req, res)));

  // Editor: list and undo/redo AI changes on one drawing.
  const accessFor = (req: express.Request, drawingId: string) =>
    getDrawingAccess({ prisma, principal: req.principal ?? null, drawingId });

  app.get("/drawings/:id/agent-changes", requireAuth, asyncHandler(async (req, res) => {
    const drawingId = String(req.params.id);
    if (!canViewDrawing(await accessFor(req, drawingId))) {
      return res.status(404).json({ error: "Not found", message: "Drawing not found" });
    }
    res.json({ changes: await listAgentChanges(prisma, drawingId, 100) });
  }));

  app.post("/drawings/:id/agent-changes/:changeId/:direction", requireAuth, asyncHandler(async (req, res) => {
    const drawingId = String(req.params.id);
    const direction = req.params.direction;
    if (direction !== "undo" && direction !== "redo") {
      return res.status(404).json({ error: "Not found" });
    }
    if (!canEditDrawing(await accessFor(req, drawingId))) {
      return res.status(403).json({ error: "Forbidden", message: "You do not have edit access to this drawing" });
    }
    try {
      const result = await revertAgentChange(changeDeps, {
        drawingId, changeId: String(req.params.changeId), direction, agent: null,
      });
      void logAuditEvent({ userId: req.user?.id, action: `agent_change_${direction}`, resource: `drawing:${drawingId}`, details: { changeId: result.changeId } });
      res.json(result);
    } catch (error) {
      if (error instanceof ChangeError) {
        return res.status(error.status).json({ error: error.status === 404 ? "Not found" : "Conflict", message: error.message });
      }
      throw error;
    }
  }));

  // Admin panel: status, live sessions, recent changes and the kill-switch.
  const requireAdmin = (req: express.Request, res: express.Response) => {
    if (req.user?.role === "ADMIN") return true;
    res.status(403).json({ error: "Forbidden", message: "Admin access required" });
    return false;
  };

  app.get("/mcp/admin", requireAuth, asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const sessions = endpoint.listSessions();
    const userIds = [...new Set(sessions.map((s) => s.userId))];
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } });
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [recent, changes24h] = await Promise.all([
      prisma.agentChange.findMany({
        orderBy: { createdAt: "desc" },
        take: 25,
        select: {
          id: true, drawingId: true, userId: true, agentName: true, agentColor: true, summary: true,
          undoneAt: true, createdAt: true, drawing: { select: { name: true } },
        },
      }),
      prisma.agentChange.count({ where: { createdAt: { gte: since } } }),
    ]);
    res.json({
      enabled: await isEnabled(),
      endpointUrl: `${publicUrl}/api/mcp`,
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        name: s.agent?.name ?? null,
        color: s.agent?.color ?? null,
        clientName: s.clientName,
        user: users.find((u) => u.id === s.userId) ?? null,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
      })),
      recentChanges: recent.map(({ drawing, ...c }) => ({ ...c, drawingName: drawing.name })),
      changes24h,
    });
  }));

  const toggleSchema = z.object({ enabled: z.boolean() });
  app.put("/mcp/admin", requireAuth, asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const parsed = toggleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request", message: "Expected { enabled: boolean }" });
    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { mcpEnabled: parsed.data.enabled },
      create: { id: "default", mcpEnabled: parsed.data.enabled },
    });
    enabledCache = null;
    void logAuditEvent({ userId: req.user?.id, action: parsed.data.enabled ? "mcp_enabled" : "mcp_disabled" });
    res.json({ enabled: parsed.data.enabled });
  }));
};
