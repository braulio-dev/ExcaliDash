import type { PrismaClient } from "../generated/client";
import { applySceneUpdateTx } from "../routes/dashboard/sceneUpdate";
import { sanitizeDrawingData } from "../security";
import { internDrawingFiles } from "../fileProcessing";
import type { AgentIdentity, AgentPresence } from "../server/agentPresence";
import { bump, type SceneElement } from "./elements";
import { replayToEditors, type ReplayExtras } from "./replay";
import { applySceneOperations, type SceneOperation, type TouchedState } from "./sceneOps";

export { replayToEditors } from "./replay";

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

// Pseudo-entries stored next to element ids in before/after for the parts of
// a change that are not element edits.
const APP_STATE_KEY = "@appState";
const ORDER_KEY = "@order";
const isMetaKey = (key: string) => key.startsWith("@");
type Meta = { viewBackgroundColor?: string; ids?: string[] };
const meta = (state: Record<string, unknown>, key: string) => state[key] as Meta | undefined;

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

export const applyAgentEdit = async (
  deps: ChangeDeps,
  args: {
    drawingId: string;
    userId: string;
    agent: AgentIdentity;
    summary: string;
    operations: SceneOperation[];
    files?: Record<string, unknown>;
    background?: string;
  },
) => {
  let result: ReturnType<typeof applySceneOperations> | null = null;
  let backgroundBefore = "#ffffff";
  const files = args.files && Object.keys(args.files).length
    ? await internDrawingFiles(args.files, args.userId, args.drawingId, deps.prisma)
    : undefined;
  const { drawing } = await applySceneUpdateTx({
    prisma: deps.prisma,
    drawingId: args.drawingId,
    parseJsonField: deps.parseJsonField,
    versionGuard: "optimistic",
    maxRetries: 4,
    mutate: (current) => {
      const elements = deps.parseJsonField<SceneElement[]>(current.elements, []);
      const applied = applySceneOperations(elements, args.operations);
      if (applied.touchedOrder.length === 0 && !applied.orderBefore && !args.background) {
        throw new ChangeError("The operations did not change anything");
      }
      const sanitized = sanitize(applied.elements);
      const byId = new Map(sanitized.map((el) => [el.id, el]));
      for (const id of Object.keys(applied.after)) applied.after[id] = byId.get(id) ?? applied.after[id];
      result = applied;
      const data: Record<string, string> = { elements: JSON.stringify(sanitized) };
      if (args.background) {
        const appState = deps.parseJsonField<Record<string, unknown>>(current.appState, {});
        backgroundBefore = String(appState.viewBackgroundColor ?? "#ffffff");
        data.appState = JSON.stringify({ ...appState, viewBackgroundColor: args.background });
      }
      return { data, ...(files ? { incomingFiles: files } : {}) };
    },
  });
  const applied = result as unknown as ReturnType<typeof applySceneOperations>;
  const before: Record<string, unknown> = { ...applied.before };
  const after: Record<string, unknown> = { ...applied.after };
  if (args.background) {
    before[APP_STATE_KEY] = { viewBackgroundColor: backgroundBefore };
    after[APP_STATE_KEY] = { viewBackgroundColor: args.background };
  }
  if (applied.orderBefore) {
    before[ORDER_KEY] = { ids: applied.orderBefore };
    after[ORDER_KEY] = { ids: applied.order };
  }
  const change = await deps.prisma.agentChange.create({
    data: {
      drawingId: args.drawingId,
      userId: args.userId,
      sessionId: args.agent.sessionId,
      agentName: args.agent.name,
      agentColor: args.agent.color,
      summary: args.summary.slice(0, 500),
      before: JSON.stringify(before),
      after: JSON.stringify(after),
      expected: JSON.stringify(after),
    },
  });
  deps.invalidateDrawingsCache();
  await replayToEditors(deps.presence, args.drawingId, args.agent, applied.touchedOrder.map((id) => applied.after[id]!), {
    files,
    elementOrder: applied.orderBefore ? applied.order : undefined,
    background: args.background,
  });
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
  const ownIds = new Set(Object.keys(after).filter((key) => !isMetaKey(key)));
  let applied: SceneElement[] = [];
  let skipped: string[] = [];
  let extras: ReplayExtras = {};

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
      extras = {};
      const data: Record<string, string> = {};
      const goalBg = meta(target, APP_STATE_KEY)?.viewBackgroundColor;
      if (goalBg) {
        const appState = deps.parseJsonField<Record<string, unknown>>(current.appState, {});
        if ((appState.viewBackgroundColor ?? "#ffffff") === meta(expected, APP_STATE_KEY)?.viewBackgroundColor) {
          data.appState = JSON.stringify({ ...appState, viewBackgroundColor: goalBg });
          extras.background = goalBg;
        } else {
          skipped.push(APP_STATE_KEY);
        }
      }
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
      const goalOrder = meta(target, ORDER_KEY)?.ids;
      if (applied.length === 0 && !extras.background && !goalOrder) {
        throw new ChangeError(
          skipped.length ? "Every element in this change was edited since; nothing to revert" : "Nothing to revert",
        );
      }
      let ordered = [...elements.map((el) => map.get(el.id)!), ...applied.filter((el) => !elements.some((e) => e.id === el.id))];
      if (goalOrder) {
        // Restore the recorded stacking order; elements added since keep their place at the end.
        const rank = new Map(goalOrder.map((id, i) => [id, i]));
        ordered = [...ordered].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
        extras.elementOrder = ordered.map((el) => el.id);
      }
      data.elements = JSON.stringify(sanitize(ordered));
      return { data };
    },
  });

  const nextExpected: Record<string, unknown> = { ...expected };
  for (const el of applied) nextExpected[el.id] = el;
  if (extras.background) nextExpected[APP_STATE_KEY] = { viewBackgroundColor: extras.background };
  await deps.prisma.agentChange.update({
    where: { id: change.id },
    data: { undoneAt: args.direction === "undo" ? new Date() : null, expected: JSON.stringify(nextExpected) },
  });
  deps.invalidateDrawingsCache();
  await replayToEditors(deps.presence, args.drawingId, args.agent, applied, extras);
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
  return rows.map(({ after, ...row }) => ({
    ...row,
    elementCount: Object.keys(JSON.parse(after)).filter((key) => !isMetaKey(key)).length,
  }));
};
