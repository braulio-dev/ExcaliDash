import { api } from "./client";

// AI (MCP) agent changes on a drawing, and the admin MCP settings.

export type AgentChange = {
  id: string;
  sessionId: string;
  agentName: string;
  agentColor: string;
  summary: string;
  elementCount: number;
  undoneAt: string | null;
  createdAt: string;
};

export type AgentChangeRevertResult = {
  changeId: string;
  reverted: string[];
  skipped: string[];
};

export const getAgentChanges = async (drawingId: string): Promise<AgentChange[]> => {
  const response = await api.get<{ changes: AgentChange[] }>(`/drawings/${drawingId}/agent-changes`);
  return response.data.changes;
};

export const revertAgentChange = async (
  drawingId: string,
  changeId: string,
  direction: "undo" | "redo",
): Promise<AgentChangeRevertResult> => {
  const response = await api.post<AgentChangeRevertResult>(
    `/drawings/${drawingId}/agent-changes/${changeId}/${direction}`,
  );
  return response.data;
};

export type McpAdminStatus = {
  enabled: boolean;
  endpointUrl: string;
  changes24h: number;
  sessions: {
    sessionId: string;
    name: string | null;
    color: string | null;
    clientName: string | null;
    user: { id: string; name: string; email: string } | null;
    createdAt: string;
    lastUsedAt: string;
  }[];
  recentChanges: {
    id: string;
    drawingId: string;
    drawingName: string;
    agentName: string;
    agentColor: string;
    summary: string;
    undoneAt: string | null;
    createdAt: string;
  }[];
};

export const getMcpAdminStatus = async (): Promise<McpAdminStatus> => {
  const response = await api.get<McpAdminStatus>("/mcp/admin");
  return response.data;
};

export const setMcpEnabled = async (enabled: boolean): Promise<{ enabled: boolean }> => {
  const response = await api.put<{ enabled: boolean }>("/mcp/admin", { enabled });
  return response.data;
};
