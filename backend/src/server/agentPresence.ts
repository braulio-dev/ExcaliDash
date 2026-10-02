import type { Server } from "socket.io";
import type { PresenceUser } from "./socketAccess";

// Server-side participants for AI agents connected over MCP. An agent has no
// real socket, so it is represented by a synthetic presence entry in the same
// `roomUsers` map the socket handlers use: browsers render it like any other
// collaborator, and its cursor and element updates are emitted on its behalf.

export type AgentIdentity = {
  sessionId: string;
  name: string;
  color: string;
};

export type AgentPresence = {
  join: (drawingId: string, agent: AgentIdentity) => void;
  leave: (drawingId: string, sessionId: string) => void;
  leaveAll: (sessionId: string) => void;
  moveCursor: (
    drawingId: string,
    agent: AgentIdentity,
    pointer: { x: number; y: number },
    selectedElementIds?: string[],
  ) => void;
  broadcastElements: (drawingId: string, elements: unknown[]) => void;
  emit: (drawingId: string, event: string, payload: unknown) => void;
  isWatched: (drawingId: string) => boolean;
};

// Leave the room after this long without agent activity so stale avatars do
// not linger when a client disconnects without closing its MCP session.
const IDLE_LEAVE_MS = 2 * 60 * 1000;

const agentSocketId = (sessionId: string) => `agent:${sessionId}`;
const roomOf = (drawingId: string) => `drawing_${drawingId}`;

const toInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  return (name.trim().slice(0, 2) || "AI").toUpperCase();
};

export const createAgentPresence = ({
  io,
  roomUsers,
}: {
  io: Server;
  roomUsers: Map<string, PresenceUser[]>;
}): AgentPresence => {
  const idleTimers = new Map<string, NodeJS.Timeout>();
  const joinedBySession = new Map<string, Set<string>>();

  const emitPresence = (roomId: string) => {
    io.to(roomId).emit("presence-update", roomUsers.get(roomId) ?? []);
  };

  const leave = (drawingId: string, sessionId: string) => {
    const roomId = roomOf(drawingId);
    const key = `${sessionId}|${drawingId}`;
    clearTimeout(idleTimers.get(key));
    idleTimers.delete(key);
    joinedBySession.get(sessionId)?.delete(drawingId);
    const users = roomUsers.get(roomId);
    if (!users) return;
    const next = users.filter((u) => u.socketId !== agentSocketId(sessionId));
    if (next.length === users.length) return;
    if (next.length === 0) roomUsers.delete(roomId);
    else roomUsers.set(roomId, next);
    emitPresence(roomId);
  };

  const touch = (drawingId: string, sessionId: string) => {
    const key = `${sessionId}|${drawingId}`;
    clearTimeout(idleTimers.get(key));
    const timer = setTimeout(() => leave(drawingId, sessionId), IDLE_LEAVE_MS);
    timer.unref?.();
    idleTimers.set(key, timer);
  };

  const join = (drawingId: string, agent: AgentIdentity) => {
    const roomId = roomOf(drawingId);
    const users = roomUsers.get(roomId) ?? [];
    const socketId = agentSocketId(agent.sessionId);
    if (!users.some((u) => u.socketId === socketId)) {
      users.push({
        id: socketId,
        name: agent.name,
        initials: toInitials(agent.name),
        color: agent.color,
        socketId,
        isActive: true,
        kind: "agent",
      });
      roomUsers.set(roomId, users);
      emitPresence(roomId);
    }
    if (!joinedBySession.has(agent.sessionId)) joinedBySession.set(agent.sessionId, new Set());
    joinedBySession.get(agent.sessionId)!.add(drawingId);
    touch(drawingId, agent.sessionId);
  };

  return {
    join,
    leave,
    leaveAll: (sessionId) => {
      for (const drawingId of [...(joinedBySession.get(sessionId) ?? [])]) {
        leave(drawingId, sessionId);
      }
      joinedBySession.delete(sessionId);
    },
    moveCursor: (drawingId, agent, pointer, selectedElementIds = []) => {
      join(drawingId, agent);
      io.to(roomOf(drawingId)).volatile.emit("cursor-move", {
        drawingId,
        pointer,
        button: "up",
        selectedElementIds: Object.fromEntries(selectedElementIds.map((id) => [id, true])),
        userId: agentSocketId(agent.sessionId),
        username: agent.name,
        color: agent.color,
      });
    },
    broadcastElements: (drawingId, elements) => {
      io.to(roomOf(drawingId)).emit("element-update", { drawingId, elements });
    },
    emit: (drawingId, event, payload) => {
      io.to(roomOf(drawingId)).emit(event, payload);
    },
    isWatched: (drawingId) =>
      (roomUsers.get(roomOf(drawingId)) ?? []).some((u) => u.kind !== "agent"),
  };
};
