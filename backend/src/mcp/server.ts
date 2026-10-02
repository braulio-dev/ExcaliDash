import { randomUUID } from "crypto";
import type express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { PrismaClient } from "../generated/client";
import { logAuditEvent } from "../utils/audit";
import type { AgentIdentity, AgentPresence } from "../server/agentPresence";
import type { ChangeDeps } from "./changes";
import { registerTools } from "./tools";

// Streamable-HTTP MCP endpoint. Each MCP session is one AI collaborator with
// its own name, colour and presence; sessions are bound to the API key's user.

export type McpSessionInfo = {
  sessionId: string;
  userId: string;
  clientName: string | null;
  agent: AgentIdentity | null;
  createdAt: Date;
  lastUsedAt: Date;
};

type Session = McpSessionInfo & { transport: StreamableHTTPServerTransport; server: McpServer };

const AGENT_COLORS = ["#e8590c", "#2f9e44", "#1971c2", "#9c36b5", "#c2255c", "#0c8599", "#f08c00", "#5f3dc4"];
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const NAME_RESERVED_MS = 10 * 60 * 1000;
const KNOWN_CLIENTS: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-ai": "Claude",
  "claude-desktop": "Claude Desktop",
};

const INSTRUCTIONS = [
  "ExcaliDash hosts Excalidraw drawings. Use list_drawings to find one, read_drawing before editing, and edit_drawing to change it.",
  "Each edit_drawing call is one undoable change; group related operations into one call with a clear summary.",
  "You appear to people viewing the drawing as a live collaborator and they watch your edits as you make them.",
  "Match the drawing's existing style (colours, font, roughness, sizes) unless asked otherwise. Leave ~40px between shapes and keep labels short.",
].join(" ");

export const createMcpEndpoint = (deps: ChangeDeps & {
  prisma: PrismaClient;
  presence: AgentPresence;
  publicUrl: string;
  isEnabled: () => Promise<boolean>;
}) => {
  const sessions = new Map<string, Session>();
  let colorCursor = 0;

  const friendlyName = (clientName: string | null) => {
    if (!clientName) return "AI assistant";
    if (KNOWN_CLIENTS[clientName]) return KNOWN_CLIENTS[clientName];
    return clientName.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40);
  };

  // Resolved on first use, after the client has introduced itself.
  const agentFor = (session: Session): AgentIdentity => {
    if (session.agent) return session.agent;
    session.clientName = session.server.server.getClientVersion()?.name ?? null;
    const base = friendlyName(session.clientName);
    // Names of sessions that went quiet are free again; clients often drop a
    // session without ending it, and "Claude Code 7" helps nobody.
    const activeSince = Date.now() - NAME_RESERVED_MS;
    const taken = new Set(
      [...sessions.values()]
        .filter((s) => s !== session && s.lastUsedAt.getTime() > activeSince)
        .map((s) => s.agent?.name)
        .filter(Boolean),
    );
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
    session.agent = { sessionId: session.sessionId, name, color: AGENT_COLORS[colorCursor++ % AGENT_COLORS.length] };
    return session.agent;
  };

  const createSession = (userId: string, ipAddress?: string) => {
    const server = new McpServer({ name: "excalidash", version: "1.0.0" }, { instructions: INSTRUCTIONS });
    const session = {
      userId, clientName: null, agent: null, createdAt: new Date(), lastUsedAt: new Date(), server,
    } as unknown as Session;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        session.sessionId = sessionId;
        sessions.set(sessionId, session);
      },
    });
    transport.onclose = () => {
      if (!session.sessionId) return;
      sessions.delete(session.sessionId);
      deps.presence.leaveAll(session.sessionId);
    };
    session.transport = transport;
    registerTools(server, {
      ...deps,
      userId,
      getAgent: () => agentFor(session),
      renameAgent: (name) => {
        const agent = agentFor(session);
        deps.presence.leaveAll(agent.sessionId);
        agent.name = name.trim().slice(0, 60);
        return agent;
      },
      log: (action, details) => {
        void logAuditEvent({ userId, action, ipAddress, details: { ...details, agent: session.agent?.name } });
      },
    });
    return session;
  };

  const sweep = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const session of sessions.values()) {
      if (session.lastUsedAt.getTime() < cutoff) void session.transport.close();
    }
  }, 10 * 60 * 1000);
  sweep.unref();

  const handle = async (req: express.Request, res: express.Response) => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!(await deps.isEnabled())) {
      res.status(503).json({ error: "Service unavailable", message: "MCP access is disabled by an administrator" });
      return;
    }
    const sessionId = req.headers["mcp-session-id"];
    let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (typeof sessionId === "string" && (!session || session.userId !== req.user.id)) {
      res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      return;
    }
    if (!session) {
      if (req.method !== "POST" || !isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Initialize a session first" }, id: null });
        return;
      }
      session = createSession(req.user.id, req.ip);
      await session.server.connect(session.transport);
    }
    session.lastUsedAt = new Date();
    await session.transport.handleRequest(req, res, req.body);
  };

  const listSessions = (): McpSessionInfo[] =>
    [...sessions.values()].map(({ transport: _t, server: _s, ...info }) => ({ ...info }));

  return { handle, listSessions };
};
