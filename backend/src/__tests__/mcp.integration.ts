import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { PrismaClient } from "../generated/client";
import { generateApiKey, serializeApiKeyScopes } from "../auth/apiKeys";
import { getTestPrisma, setupTestDb } from "./testUtils";

const createUserWithKey = async (prisma: PrismaClient, email: string, role: "ADMIN" | "USER") => {
  const user = await prisma.user.create({
    data: { email, passwordHash: await bcrypt.hash("password123", 10), name: email.split("@")[0], role, isActive: true },
  });
  const generated = generateApiKey();
  await prisma.apiKey.create({
    data: {
      userId: user.id, name: "mcp", keyId: generated.keyId, tokenHash: generated.tokenHash,
      prefix: generated.prefix, scopes: serializeApiKeyScopes(),
    },
  });
  return { userId: user.id, token: generated.token };
};

describe("MCP endpoint", () => {
  let prisma: PrismaClient;
  let app: any;
  let admin: { userId: string; token: string };
  let other: { userId: string; token: string };
  let sessionId: string;
  let rpcId = 1;

  const rpc = async (token: string, method: string, params: unknown, session?: string) => {
    const req = request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", "application/json, text/event-stream")
      .set("Content-Type", "application/json");
    if (session) req.set("mcp-session-id", session);
    return req.send({ jsonrpc: "2.0", id: rpcId++, method, params });
  };

  const initialize = async (token: string, clientName = "claude-code") => {
    const res = await rpc(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
    });
    expect(res.status).toBe(200);
    const id = res.headers["mcp-session-id"];
    await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", "application/json, text/event-stream")
      .set("mcp-session-id", id)
      .send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return id as string;
  };

  const call = async (name: string, args: Record<string, unknown>, session = sessionId, token = admin.token) => {
    const res = await rpc(token, "tools/call", { name, arguments: args }, session);
    expect(res.status).toBe(200);
    const result = res.body.result;
    const text = result.content[0].text as string;
    return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
  };

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ app } = await import("../index"));
    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { authEnabled: true, mcpEnabled: true },
      create: { id: "default", authEnabled: true, mcpEnabled: true },
    });
    admin = await createUserWithKey(prisma, "mcp-admin@test.local", "ADMIN");
    other = await createUserWithKey(prisma, "mcp-other@test.local", "USER");
    sessionId = await initialize(admin.token);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("requires an API key and an initialized session", async () => {
    // Without a bearer key the request is a browser-style call and CSRF rejects it first.
    expect([401, 403]).toContain((await request(app).post("/mcp").send({})).status);
    const res = await rpc(admin.token, "tools/list", {});
    expect(res.status).toBe(400);
  });

  it("lists the drawing tools", async () => {
    const res = await rpc(admin.token, "tools/list", {}, sessionId);
    const names = res.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      "list_drawings", "read_drawing", "edit_drawing", "undo_change", "redo_change", "list_changes", "create_drawing", "set_agent_name",
    ]));
  });

  it("creates, edits, undoes and redoes a drawing", async () => {
    const created = await call("create_drawing", { name: "MCP flow" });
    const drawingId = created.data.id;

    const edit = await call("edit_drawing", {
      drawingId,
      summary: "Add two steps",
      operations: [
        { op: "add", element: { type: "rectangle", id: "s1", x: 0, y: 0, label: "Step 1" } },
        { op: "add", element: { type: "rectangle", id: "s2", x: 0, y: 200, label: "Step 2" } },
        { op: "add", element: { type: "arrow", id: "s1s2", startId: "s1", endId: "s2" } },
      ],
    });
    expect(edit.isError).toBe(false);
    expect(edit.data.createdIds).toEqual(["s1", "s2", "s1s2"]);

    const read = await call("read_drawing", { drawingId });
    expect(read.data.elementCount).toBe(3);
    expect(read.data.elements.find((e: any) => e.id === "s1").label).toBe("Step 1");
    expect(read.data.recentAiChanges[0]).toMatchObject({ by: "Claude Code", summary: "Add two steps", undone: false });

    // A browser receiving the agent's elements re-saves them with fractional
    // indexes and bumped versions; that must not count as a human edit.
    const stored = await prisma.drawing.findUniqueOrThrow({ where: { id: drawingId } });
    const resaved = JSON.parse(stored.elements).map((el: any, i: number) => ({
      ...el, index: `a${i}`, version: el.version + 1, versionNonce: el.versionNonce + 1,
      boundElements: el.boundElements ?? [],
    }));
    await prisma.drawing.update({ where: { id: drawingId }, data: { elements: JSON.stringify(resaved) } });

    const move = await call("edit_drawing", {
      drawingId, summary: "Move step 2", operations: [{ op: "update", id: "s2", set: { x: 300 } }],
    });
    expect(move.isError).toBe(false);

    // Undo without a changeId reverts this session's latest change (the move).
    const undo = await call("undo_change", { drawingId });
    expect(undo.data.changeId).toBe(move.data.changeId);
    const afterUndo = await call("read_drawing", { drawingId });
    expect(afterUndo.data.elements.find((e: any) => e.id === "s2").x).toBe(0);

    const redo = await call("redo_change", { drawingId });
    expect(redo.data.changeId).toBe(move.data.changeId);
    const afterRedo = await call("read_drawing", { drawingId });
    expect(afterRedo.data.elements.find((e: any) => e.id === "s2").x).toBe(300);

    // The editor can undo the first change over REST; the agent's elements disappear.
    const list = await request(app).get(`/drawings/${drawingId}/agent-changes`).set("Authorization", `Bearer ${admin.token}`);
    expect(list.body.changes).toHaveLength(2);
    const undoFirst = await request(app)
      .post(`/drawings/${drawingId}/agent-changes/${edit.data.changeId}/undo`)
      .set("Authorization", `Bearer ${admin.token}`);
    expect(undoFirst.status).toBe(200);
    // s2 (and the arrow re-routed with it) changed in a later change, so they
    // are skipped rather than clobbered; s1 and its label are removed.
    expect(undoFirst.body.skipped).toEqual(expect.arrayContaining(["s2", "s1s2"]));
    const final = await call("read_drawing", { drawingId });
    expect(final.data.elements.map((e: any) => e.id).sort()).toEqual(["s1s2", "s2"]);

    const again = await request(app)
      .post(`/drawings/${drawingId}/agent-changes/${edit.data.changeId}/undo`)
      .set("Authorization", `Bearer ${admin.token}`);
    expect(again.status).toBe(409);
  });

  it("lists drawings outside any collection but not trashed ones", async () => {
    const kept = await call("create_drawing", { name: "Loose drawing" });
    const trashed = await call("create_drawing", { name: "Trashed drawing" });
    await prisma.collection.upsert({
      where: { id: `trash:${admin.userId}` },
      update: {},
      create: { id: `trash:${admin.userId}`, name: "Trash", userId: admin.userId },
    });
    await prisma.drawing.update({ where: { id: trashed.data.id }, data: { collectionId: `trash:${admin.userId}` } });
    const listed = await call("list_drawings", { limit: 100 });
    const ids = listed.data.map((d: any) => d.id);
    expect(ids).toContain(kept.data.id);
    expect(ids).not.toContain(trashed.data.id);
  });

  it("reports invalid operations as tool errors without changing the drawing", async () => {
    const { data } = await call("create_drawing", { name: "Errors" });
    const bad = await call("edit_drawing", {
      drawingId: data.id, summary: "Bad", operations: [{ op: "delete", id: "missing" }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/No element/);
    expect(await prisma.agentChange.count({ where: { drawingId: data.id } })).toBe(0);
  });

  it("keeps other users' drawings and sessions private", async () => {
    const { data } = await call("create_drawing", { name: "Private" });
    const otherSession = await initialize(other.token, "claude-code");
    const denied = await call("read_drawing", { drawingId: data.id }, otherSession, other.token);
    expect(denied.isError).toBe(true);
    const listed = await call("list_drawings", {}, otherSession, other.token);
    expect(listed.data).toEqual([]);
    // A session id cannot be reused with another user's key.
    const hijack = await rpc(other.token, "tools/list", {}, sessionId);
    expect(hijack.status).toBe(404);
  });

  it("gives each session its own collaborator name", async () => {
    const second = await initialize(admin.token, "claude-code");
    const { data } = await call("create_drawing", { name: "Names" }, second);
    await call("read_drawing", { drawingId: data.id }, second);
    const status = await request(app).get("/mcp/admin").set("Authorization", `Bearer ${admin.token}`);
    const names = status.body.sessions.map((s: any) => s.name).filter(Boolean);
    expect(names).toContain("Claude Code");
    expect(names).toContain("Claude Code 2");
  });

  it("admin can see status and switch MCP off", async () => {
    const status = await request(app).get("/mcp/admin").set("Authorization", `Bearer ${admin.token}`);
    expect(status.status).toBe(200);
    expect(status.body.enabled).toBe(true);
    expect(status.body.recentChanges.length).toBeGreaterThan(0);
    expect((await request(app).get("/mcp/admin").set("Authorization", `Bearer ${other.token}`)).status).toBe(403);

    const off = await request(app).put("/mcp/admin").set("Authorization", `Bearer ${admin.token}`).send({ enabled: false });
    expect(off.body.enabled).toBe(false);
    expect((await rpc(admin.token, "tools/list", {}, sessionId)).status).toBe(503);
    await request(app).put("/mcp/admin").set("Authorization", `Bearer ${admin.token}`).send({ enabled: true });
    expect((await rpc(admin.token, "tools/list", {}, sessionId)).status).toBe(200);
  });
});
