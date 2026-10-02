import type { PrismaClient } from "../generated/client";
import { applySceneUpdateTx } from "../routes/dashboard/sceneUpdate";
import { sanitizeDrawingData } from "../security";
import type { AgentIdentity, AgentPresence } from "../server/agentPresence";
import { bump, type SceneElement } from "./elements";
import { applySceneOperations, type SceneOperation, type TouchedState } from "./sceneOps";

// Persists agent edits as undoable change sets and replays them to open
// editors through the agent's live-collaborator presence.

export type ChangeDeps = {
  prisma: PrismaClient;
  presence: AgentPresence;
  parseJsonField: <T>(raw: string | null | undefined, fallback: T) => T;
  invalidateDrawingsCache: () => void;
};

// Each touched element as this change (or its last undo/redo) left it.
type Expected = Record<string, SceneElement | null>;

export class ChangeError extends Error {
  constructor(message: string, readonly status: 404 | 409 = 409) {
    super(message);
  }
}

const sanitize = (elements: SceneElement[]): SceneElement[] =>
  sanitizeDrawingData({ elements, appState: {} }).elements as SceneElement[];

// Bookkeeping that clients rewrite without anyone editing the element:
// Excalidraw assigns fractional `index`es (bumping the version) and
// normalises bindings when it receives remote elements.
const BOOKKEEPING_KEYS = new Set(["version", "versionNonce", "updated", "index", "boundElements", "seed"]);

const sameValue = (a: unknown, b: unknown): boolean => {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 0.01;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => sameValue((a as any)[k], (b as any)[k]));
  }
  return (a ?? null) === (b ?? null);
};

// True when `current` still looks the way this change left it, i.e. nobody
// has edited it since. Keys the client added on its own are ignored.
export const isUnchangedSince = (current: SceneElement | undefined, expected: SceneElement | null): boolean => {
  const goneNow = !current || Boolean(current.isDeleted);
  if (!expected || expected.isDeleted) return goneNow;
  if (goneNow) return false;
  return Object.keys(expected).every(
    (key) => BOOKKEEPING_KEYS.has(key) || key === "isDeleted" || sameValue(current![key], expected[key]),
  );
};

// Shapes first and connectors last, so arrows never reach a client before the
// shapes they attach to.
const replayRank = (el: SceneElement) =>
  el.type === "arrow" || el.type === "line" ? 2 : el.type === "text" && !el.containerId ? 1 : 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Stream elements to open editors one at a time with the agent's cursor on
// each, so edits are watchable. Skipped when nobody has the drawing open.
export const replayToEditors = async (
  presence: AgentPresence,
  drawingId: string,
  agent: AgentIdentity | null,
  elements: SceneElement[],
) => {
  if (!presence.isWatched(drawingId) || elements.length === 0) {
    presence.broadcastElements(drawingId, elements);
    return;
  }
  const byId = new Map(elements.map((el) => [el.id, el]));
  const steps = elements
    .filter((el) => !(el.type === "text" && el.containerId && byId.has(el.containerId)))
    .sort((a, b) => replayRank(a) - replayRank(b));
  const delay = Math.max(40, Math.min(220, 3500 / steps.length));
  for (const el of steps) {
    const group = [el, ...elements.filter((t) => t.type === "text" && t.containerId === el.id)];
    if (agent) {
      presence.moveCursor(drawingId, agent, { x: el.x + el.width / 2, y: el.y + el.height / 2 }, el.isDeleted ? [] : [el.id]);
    }
    presence.broadcastElements(drawingId, group);
    await sleep(delay);
  }
  presence.broadcastElements(drawingId, elements);
  if (agent) presence.moveCursor(drawingId, agent, { x: steps[steps.length - 1].x, y: steps[steps.length - 1].y - 40 }, []);
};

export const applyAgentEdit = async (
  deps: ChangeDeps,
  args: { drawingId: string; userId: string; agent: AgentIdentity; summary: string; operations: SceneOperation[] },
) => {
  let result: ReturnType<typeof applySceneOperations> | null = null;
  const { drawing } = await applySceneUpdateTx({
    prisma: deps.prisma,
    drawingId: args.drawingId,
    parseJsonField: deps.parseJsonField,
    versionGuard: "optimistic",
    maxRetries: 4,
    mutate: (current) => {
      const elements = deps.parseJsonField<SceneElement[]>(current.elements, []);
      const applied = applySceneOperations(elements, args.operations);
      if (applied.touchedOrder.length === 0) throw new ChangeError("The operations did not change anything");
      const sanitized = sanitize(applied.elements);
      const byId = new Map(sanitized.map((el) => [el.id, el]));
      for (const id of Object.keys(applied.after)) applied.after[id] = byId.get(id) ?? applied.after[id];
      result = applied;
      return { data: { elements: JSON.stringify(sanitized) } };
    },
  });
  const applied = result as unknown as ReturnType<typeof applySceneOperations>;
  const change = await deps.prisma.agentChange.create({
    data: {
      drawingId: args.drawingId,
      userId: args.userId,
      sessionId: args.agent.sessionId,
      agentName: args.agent.name,
      agentColor: args.agent.color,
      summary: args.summary.slice(0, 500),
      before: JSON.stringify(applied.before),
      after: JSON.stringify(applied.after),
      expected: JSON.stringify(applied.after),
    },
  });
  deps.invalidateDrawingsCache();
  await replayToEditors(deps.presence, args.drawingId, args.agent, applied.touchedOrder.map((id) => applied.after[id]!));
  deps.presence.emit(args.drawingId, "agent-change", {
    drawingId: args.drawingId, changeId: change.id, kind: "edit", agentName: args.agent.name, agentColor: args.agent.color, summary: change.summary,
  });
  return { changeId: change.id, created: applied.created, touched: applied.touchedOrder, version: drawing.version };
};

// Undo (restore `before`) or redo (re-apply `after`) one change. Elements that
// someone else edited since are left alone and reported as skipped.
export const revertAgentChange = async (
  deps: ChangeDeps,
  args: { drawingId: string; changeId: string; direction: "undo" | "redo"; agent: AgentIdentity | null },
) => {
  const change = await deps.prisma.agentChange.findFirst({
    where: { id: args.changeId, drawingId: args.drawingId },
  });
  if (!change) throw new ChangeError("Change not found", 404);
  if (args.direction === "undo" && change.undoneAt) throw new ChangeError("This change is already undone");
  if (args.direction === "redo" && !change.undoneAt) throw new ChangeError("This change has not been undone");

  const before = JSON.parse(change.before) as TouchedState;
  const after = JSON.parse(change.after) as TouchedState;
  const expected = JSON.parse(change.expected) as Expected;
  const target = args.direction === "undo" ? before : after;
  const ownIds = new Set(Object.keys(after));
  let applied: SceneElement[] = [];
  let skipped: string[] = [];

  await applySceneUpdateTx({
    prisma: deps.prisma,
    drawingId: args.drawingId,
    parseJsonField: deps.parseJsonField,
    versionGuard: "optimistic",
    maxRetries: 4,
    mutate: (current) => {
      const elements = deps.parseJsonField<SceneElement[]>(current.elements, []);
      const map = new Map(elements.map((el) => [el.id, el]));
      applied = [];
      skipped = [];
      for (const id of ownIds) {
        const cur = map.get(id);
        if (!isUnchangedSince(cur, expected[id] ?? null)) {
          skipped.push(id);
          continue;
        }
        const goal = target[id];
        let next: SceneElement | null = null;
        if (goal === null) next = cur ? { ...cur, isDeleted: true } : null;
        else {
          // Keep bindings other people added since; this change owns only its own ids.
          const foreign = (cur?.boundElements ?? []).filter((b: { id: string }) => !ownIds.has(b.id));
          const own = (goal.boundElements ?? []).filter((b: { id: string }) => ownIds.has(b.id) ? target[b.id] && !target[b.id]!.isDeleted : true);
          const bound = [...own, ...foreign.filter((b: { id: string }) => !own.some((o: { id: string }) => o.id === b.id))];
          next = { ...goal, boundElements: bound.length ? bound : null };
        }
        if (!next) continue;
        next = bump(next, Math.max(cur?.version ?? 0, next.version));
        map.set(id, next);
        applied.push(next);
      }
      if (applied.length === 0) {
        throw new ChangeError(
          skipped.length ? "Every element in this change was edited since; nothing to revert" : "Nothing to revert",
        );
      }
      const ordered = [...elements.map((el) => map.get(el.id)!), ...applied.filter((el) => !elements.some((e) => e.id === el.id))];
      return { data: { elements: JSON.stringify(sanitize(ordered)) } };
    },
  });

  const nextExpected: Expected = { ...expected };
  for (const el of applied) nextExpected[el.id] = el;
  await deps.prisma.agentChange.update({
    where: { id: change.id },
    data: { undoneAt: args.direction === "undo" ? new Date() : null, expected: JSON.stringify(nextExpected) },
  });
  deps.invalidateDrawingsCache();
  await replayToEditors(deps.presence, args.drawingId, args.agent, applied);
  deps.presence.emit(args.drawingId, "agent-change", {
    drawingId: args.drawingId, changeId: change.id, kind: args.direction, agentName: args.agent?.name ?? null, summary: change.summary,
  });
  return { changeId: change.id, reverted: applied.map((el) => el.id), skipped };
};

export const listAgentChanges = async (prisma: PrismaClient, drawingId: string, limit = 50) => {
  const rows = await prisma.agentChange.findMany({
    where: { drawingId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
    select: { id: true, sessionId: true, agentName: true, agentColor: true, summary: true, after: true, undoneAt: true, createdAt: true },
  });
  return rows.map(({ after, ...row }) => ({ ...row, elementCount: Object.keys(JSON.parse(after)).length }));
};
