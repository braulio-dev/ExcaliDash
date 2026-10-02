import type { AgentIdentity, AgentPresence } from "../server/agentPresence";
import type { SceneElement } from "./elements";

// Streams an agent's edits to open editors so people watch them happen, and
// sends the non-element parts of a change (files, order, background).

export type ReplayExtras = {
  files?: Record<string, unknown>;
  elementOrder?: string[];
  background?: string;
};

// Shapes first and connectors last, so arrows never reach a client before the
// shapes they attach to; frames go last so their children are already there.
const replayRank = (el: SceneElement) =>
  el.type === "frame" ? 3 : el.type === "arrow" || el.type === "line" ? 2 : el.type === "text" && !el.containerId ? 1 : 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const emitExtras = (presence: AgentPresence, drawingId: string, extras: ReplayExtras) => {
  if (extras.elementOrder) presence.broadcastElements(drawingId, [], { elementOrder: extras.elementOrder });
  if (extras.background) {
    presence.emit(drawingId, "scene-appstate", { drawingId, appState: { viewBackgroundColor: extras.background } });
  }
};

// One element at a time with the agent's cursor on each. When nobody has the
// drawing open everything is sent at once.
export const replayToEditors = async (
  presence: AgentPresence,
  drawingId: string,
  agent: AgentIdentity | null,
  elements: SceneElement[],
  extras: ReplayExtras = {},
) => {
  const fileExtra = extras.files && Object.keys(extras.files).length ? { files: extras.files } : {};
  if (!presence.isWatched(drawingId) || elements.length === 0) {
    if (elements.length) presence.broadcastElements(drawingId, elements, fileExtra);
    emitExtras(presence, drawingId, extras);
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
    presence.broadcastElements(drawingId, group, el.type === "image" ? fileExtra : {});
    await sleep(delay);
  }
  presence.broadcastElements(drawingId, elements, fileExtra);
  emitExtras(presence, drawingId, extras);
  if (agent) presence.moveCursor(drawingId, agent, { x: steps[steps.length - 1].x, y: steps[steps.length - 1].y - 40 }, []);
};
