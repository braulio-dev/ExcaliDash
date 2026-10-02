import { toast } from "sonner";
import * as api from "../api";

// Shared by the AI changes panel and the editor's agent-change toasts.

export const AGENT_CHANGE_EVENT = "excalidash:agent-change";

export type AgentChangeEventDetail = {
  drawingId: string;
  changeId: string;
  kind: "edit" | "undo" | "redo";
  agentName: string | null;
  agentColor?: string;
  summary: string;
};

export const revertAgentChangeWithToast = async (
  drawingId: string,
  changeId: string,
  direction: "undo" | "redo",
) => {
  try {
    const result = await api.revertAgentChange(drawingId, changeId, direction);
    const verb = direction === "undo" ? "Undid" : "Redid";
    if (result.skipped.length > 0) {
      toast.warning(`${verb} the change, except ${result.skipped.length} element(s) edited since`);
    } else {
      toast.success(`${verb} the AI change`);
    }
    return true;
  } catch (err: unknown) {
    const message = api.isAxiosError(err)
      ? err.response?.data?.message || `Could not ${direction} the change`
      : `Could not ${direction} the change`;
    toast.error(message);
    return false;
  }
};
