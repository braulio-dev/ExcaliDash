import { toast } from "sonner";
import {
  AGENT_CHANGE_EVENT,
  revertAgentChangeWithToast,
  type AgentChangeEventDetail,
} from "../../utils/agentChanges";

// Relay `agent-change` socket events to the AI changes panel, and offer a
// one-click undo when an AI edits the drawing that is open.
export const handleAgentChangeEvent = (payload: AgentChangeEventDetail) => {
  if (!payload?.drawingId || !payload.changeId) return;
  window.dispatchEvent(new CustomEvent(AGENT_CHANGE_EVENT, { detail: payload }));
  if (payload.kind !== "edit") return;
  toast(`${payload.agentName ?? "AI"}: ${payload.summary}`, {
    id: `agent-change-${payload.changeId}`,
    duration: 8000,
    action: {
      label: "Undo",
      onClick: () => {
        void revertAgentChangeWithToast(payload.drawingId, payload.changeId, "undo");
      },
    },
  });
};
