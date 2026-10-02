import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Redo2, Undo2, X } from "lucide-react";
import clsx from "clsx";
import * as api from "../api";
import { AGENT_CHANGE_EVENT, revertAgentChangeWithToast, type AgentChangeEventDetail } from "../utils/agentChanges";

// Side panel listing AI (MCP) edits to the open drawing, each with undo/redo.
// AI edits are not in Excalidraw's local undo stack, so this is where they
// are reverted from the editor.

type Props = {
  drawingId: string;
  isOpen: boolean;
  onClose: () => void;
};

const timeAgo = (dateStr: string): string => {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

export const AgentChangesPanel: React.FC<Props> = ({ drawingId, isOpen, onClose }) => {
  const [changes, setChanges] = useState<api.AgentChange[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setChanges(await api.getAgentChanges(drawingId));
    } catch {
      // Panel stays empty; the next agent event retries.
    } finally {
      setLoading(false);
    }
  }, [drawingId]);

  useEffect(() => {
    if (!isOpen) return;
    void load();
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<AgentChangeEventDetail>).detail;
      if (detail?.drawingId === drawingId) void load();
    };
    window.addEventListener(AGENT_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(AGENT_CHANGE_EVENT, onChange);
  }, [isOpen, load, drawingId]);

  const revert = async (change: api.AgentChange) => {
    setBusyId(change.id);
    await revertAgentChangeWithToast(drawingId, change.id, change.undoneAt ? "redo" : "undo");
    setBusyId(null);
    void load();
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex justify-end">
      <div className="absolute inset-0 bg-neutral-900/20 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-sm bg-white dark:bg-neutral-900 border-l-2 border-black dark:border-neutral-700 shadow-[-4px_0px_0px_0px_rgba(0,0,0,1)] dark:shadow-[-4px_0px_0px_0px_rgba(255,255,255,0.08)] animate-in slide-in-from-right duration-200 flex flex-col h-full">
        <div className="flex items-center justify-between p-4 border-b-2 border-black dark:border-neutral-700">
          <div className="flex items-center gap-2">
            <Bot size={18} className="text-indigo-600 dark:text-indigo-400 shrink-0" />
            <h2 className="text-base font-bold text-neutral-900 dark:text-neutral-100">AI changes</h2>
            {changes.length > 0 && (
              <span className="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide border bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800">
                {changes.length}
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-neutral-400 hover:text-neutral-950 dark:hover:text-white transition-colors">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {loading && changes.length === 0 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400 p-2">Loading…</p>
          ) : changes.length === 0 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400 p-2">
              No AI edits yet. Changes made through the MCP connector show up here, and each one can be undone.
            </p>
          ) : (
            changes.map((change) => (
              <div
                key={change.id}
                className={clsx(
                  "rounded-xl border-2 p-3 transition-colors",
                  change.undoneAt
                    ? "border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/60"
                    : "border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900",
                )}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: change.agentColor }} />
                  <span className="text-xs font-bold text-neutral-800 dark:text-neutral-200 truncate">{change.agentName}</span>
                  <span className="text-[11px] text-neutral-500 dark:text-neutral-400 ml-auto shrink-0">{timeAgo(change.createdAt)}</span>
                </div>
                <p className={clsx("text-sm text-neutral-900 dark:text-neutral-100", change.undoneAt && "line-through opacity-60")}>
                  {change.summary}
                </p>
                <div className="flex items-center justify-between mt-2">
                  <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                    {change.elementCount} element{change.elementCount === 1 ? "" : "s"}
                    {change.undoneAt ? " · undone" : ""}
                  </span>
                  <button
                    onClick={() => void revert(change)}
                    disabled={busyId !== null}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg border-2 border-black dark:border-neutral-600 text-xs font-bold text-neutral-800 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50 transition-colors"
                  >
                    {change.undoneAt ? <Redo2 size={13} /> : <Undo2 size={13} />}
                    {busyId === change.id ? "Working…" : change.undoneAt ? "Redo" : "Undo"}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
