import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChangesPanel } from "./AgentChangesPanel";
import { AGENT_CHANGE_EVENT } from "../utils/agentChanges";
import * as api from "../api";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), warning: vi.fn(), error: vi.fn() }),
}));

vi.mock("../api", () => ({
  isAxiosError: vi.fn(() => false),
  getAgentChanges: vi.fn(),
  revertAgentChange: vi.fn(),
}));

const change = (overrides: Partial<api.AgentChange> = {}): api.AgentChange => ({
  id: "c1",
  sessionId: "s1",
  agentName: "Claude Code",
  agentColor: "#e8590c",
  summary: "Add approval step",
  elementCount: 3,
  undoneAt: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe("AgentChangesPanel", () => {
  beforeEach(() => {
    vi.mocked(api.getAgentChanges).mockReset();
    vi.mocked(api.revertAgentChange).mockReset();
  });

  it("lists AI changes and undoes one", async () => {
    vi.mocked(api.getAgentChanges)
      .mockResolvedValueOnce([change()])
      .mockResolvedValueOnce([change({ undoneAt: new Date().toISOString() })]);
    vi.mocked(api.revertAgentChange).mockResolvedValue({ changeId: "c1", reverted: ["a"], skipped: [] });

    render(<AgentChangesPanel drawingId="d1" isOpen onClose={() => {}} />);

    expect(await screen.findByText("Add approval step")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));

    await waitFor(() => expect(api.revertAgentChange).toHaveBeenCalledWith("d1", "c1", "undo"));
    expect(await screen.findByRole("button", { name: /redo/i })).toBeInTheDocument();
  });

  it("reloads when an agent change event arrives for this drawing", async () => {
    vi.mocked(api.getAgentChanges).mockResolvedValue([]);
    render(<AgentChangesPanel drawingId="d1" isOpen onClose={() => {}} />);
    await waitFor(() => expect(api.getAgentChanges).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new CustomEvent(AGENT_CHANGE_EVENT, { detail: { drawingId: "other" } }));
      window.dispatchEvent(new CustomEvent(AGENT_CHANGE_EVENT, { detail: { drawingId: "d1" } }));
    });
    await waitFor(() => expect(api.getAgentChanges).toHaveBeenCalledTimes(2));
  });

  it("renders nothing when closed", () => {
    const { container } = render(<AgentChangesPanel drawingId="d1" isOpen={false} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    expect(api.getAgentChanges).not.toHaveBeenCalled();
  });
});
