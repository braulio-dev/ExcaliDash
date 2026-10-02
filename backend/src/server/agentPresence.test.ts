import { describe, expect, it } from "vitest";
import { createAgentPresence } from "./agentPresence";
import { replayToEditors } from "../mcp/changes";
import type { PresenceUser } from "./socketAccess";

const fakeIo = () => {
  const emitted: { room: string; event: string; payload: any }[] = [];
  const target = (room: string) => ({
    emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }),
    volatile: { emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) },
  });
  return { io: { to: (room: string) => ({ ...target(room), volatile: target(room) }) } as any, emitted };
};

const human: PresenceUser = { id: "u1", name: "Pat", initials: "PA", color: "#000", socketId: "s1", isActive: true };
const agent = { sessionId: "sess-1", name: "Claude Code", color: "#e8590c" };

describe("agent presence", () => {
  it("joins a room as its own collaborator and leaves cleanly", () => {
    const { io, emitted } = fakeIo();
    const roomUsers = new Map<string, PresenceUser[]>([["drawing_d1", [human]]]);
    const presence = createAgentPresence({ io, roomUsers });

    presence.join("d1", agent);
    presence.join("d1", agent); // idempotent
    const users = roomUsers.get("drawing_d1")!;
    expect(users).toHaveLength(2);
    expect(users[1]).toMatchObject({ id: "agent:sess-1", name: "Claude Code", initials: "CC", kind: "agent" });
    expect(emitted.filter((e) => e.event === "presence-update")).toHaveLength(1);
    expect(presence.isWatched("d1")).toBe(true);

    presence.leaveAll("sess-1");
    expect(roomUsers.get("drawing_d1")).toEqual([human]);
  });

  it("is not 'watched' when only agents are present", () => {
    const { io } = fakeIo();
    const presence = createAgentPresence({ io, roomUsers: new Map() });
    presence.join("d2", agent);
    expect(presence.isWatched("d2")).toBe(false);
  });

  it("streams elements one by one with the agent's cursor when someone is watching", async () => {
    const { io, emitted } = fakeIo();
    const roomUsers = new Map<string, PresenceUser[]>([["drawing_d1", [human]]]);
    const presence = createAgentPresence({ io, roomUsers });
    const shape = { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 50, version: 1 };
    const label = { id: "t", type: "text", containerId: "a", x: 10, y: 10, width: 40, height: 20, version: 1 };
    const arrow = { id: "ar", type: "arrow", x: 100, y: 25, width: 50, height: 0, version: 1 };

    await replayToEditors(presence, "d1", agent, [arrow, shape, label] as any);

    const updates = emitted.filter((e) => e.event === "element-update").map((e) => e.payload.elements.map((el: any) => el.id));
    // Shape (with its label) arrives before the arrow, then a final full sync.
    expect(updates).toEqual([["a", "t"], ["ar"], ["ar", "a", "t"]]);
    const cursors = emitted.filter((e) => e.event === "cursor-move");
    expect(cursors[0].payload).toMatchObject({ userId: "agent:sess-1", username: "Claude Code", pointer: { x: 50, y: 25 } });
  });

  it("sends a single update when nobody has the drawing open", async () => {
    const { io, emitted } = fakeIo();
    const presence = createAgentPresence({ io, roomUsers: new Map() });
    await replayToEditors(presence, "d1", agent, [{ id: "a", type: "rectangle", x: 0, y: 0, width: 1, height: 1, version: 1 }] as any);
    expect(emitted.filter((e) => e.event === "element-update")).toHaveLength(1);
    expect(emitted.filter((e) => e.event === "cursor-move")).toHaveLength(0);
  });
});
