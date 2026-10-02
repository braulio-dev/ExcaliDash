import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, RefreshCw } from 'lucide-react';
import * as api from '../../api';
import { CopyBlock, McpSetupTabs } from './McpSetupTabs';

// Admin section for the MCP endpoint AI agents (e.g. Claude) use to edit
// drawings as live collaborators: kill-switch, connection details, who is
// connected right now and the latest AI edits across all drawings.

const cardClassName =
  'mb-6 bg-white dark:bg-neutral-900 border-2 border-black dark:border-neutral-700 rounded-2xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,0.2)] p-4 sm:p-6';
const labelClassName = 'block text-sm font-bold text-slate-700 dark:text-neutral-300 mb-2';

const timeAgo = (dateStr: string) => {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

export const McpCard: React.FC<{ isAdmin: boolean; setError: (message: string) => void }> = ({ isAdmin, setError }) => {
  const [status, setStatus] = useState<api.McpAdminStatus | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.getMcpAdminStatus());
    } catch {
      setError('Failed to load MCP status');
    }
  }, [setError]);

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  const toggle = async () => {
    if (!status) return;
    setSaving(true);
    try {
      const { enabled } = await api.setMcpEnabled(!status.enabled);
      setStatus({ ...status, enabled });
    } catch {
      setError('Failed to update MCP access');
    } finally {
      setSaving(false);
    }
  };

  const endpoint = status?.endpointUrl ?? '';

  return (
    <div className={cardClassName}>
      <div className="flex items-center gap-3 mb-4">
        <div className="w-12 h-12 bg-indigo-50 dark:bg-neutral-800 rounded-xl flex items-center justify-center border-2 border-indigo-100 dark:border-neutral-700">
          <Bot size={24} className="text-indigo-700 dark:text-indigo-300" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white">AI Agents (MCP)</h2>
          <p className="text-sm text-slate-600 dark:text-neutral-400 font-medium">
            Let Claude and other MCP clients read and edit drawings. Each AI session joins as a live
            collaborator, and every edit can be undone from the editor's AI changes panel.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          title="Refresh"
          className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white transition-colors"
        >
          <RefreshCw size={18} />
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <div>
          <div className={labelClassName}>MCP access</div>
          <button
            type="button"
            onClick={() => void toggle()}
            disabled={!status || saving}
            className={`w-full px-4 py-3 rounded-xl border-2 font-bold transition-all text-sm ${
              status?.enabled
                ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300'
                : 'border-slate-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-slate-600 dark:text-neutral-300'
            }`}
          >
            {!status ? 'Loading…' : saving ? 'Saving…' : status.enabled ? 'Enabled' : 'Disabled'}
          </button>
        </div>
        <div className="lg:col-span-2">
          <CopyBlock label="Endpoint" value={endpoint || 'Loading…'} />
        </div>
      </div>

      <McpSetupTabs endpoint={endpoint || 'https://<your-host>/api/mcp'} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-6">
        <div>
          <div className={labelClassName}>Connected now ({status?.sessions.length ?? 0})</div>
          <div className="rounded-xl border-2 border-slate-200 dark:border-neutral-700 divide-y-2 divide-slate-100 dark:divide-neutral-800">
            {status && status.sessions.length === 0 && (
              <p className="p-3 text-sm text-slate-500 dark:text-neutral-400">No AI sessions connected.</p>
            )}
            {status?.sessions.map((s) => (
              <div key={s.sessionId} className="p-3 flex items-center gap-2 text-sm">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color ?? '#94a3b8' }} />
                <span className="font-bold text-slate-800 dark:text-neutral-100 truncate">{s.name ?? s.clientName ?? 'Connecting…'}</span>
                <span className="text-slate-500 dark:text-neutral-400 truncate">{s.user?.email}</span>
                <span className="ml-auto text-xs text-slate-500 dark:text-neutral-400 shrink-0">{timeAgo(s.lastUsedAt)}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className={labelClassName}>Recent AI edits ({status?.changes24h ?? 0} in 24h)</div>
          <div className="rounded-xl border-2 border-slate-200 dark:border-neutral-700 divide-y-2 divide-slate-100 dark:divide-neutral-800 max-h-72 overflow-y-auto">
            {status && status.recentChanges.length === 0 && (
              <p className="p-3 text-sm text-slate-500 dark:text-neutral-400">No AI edits yet.</p>
            )}
            {status?.recentChanges.map((c) => (
              <div key={c.id} className="p-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: c.agentColor }} />
                  <span className="font-bold text-slate-800 dark:text-neutral-100 truncate">{c.agentName}</span>
                  <Link to={`/editor/${c.drawingId}`} className="text-indigo-700 dark:text-indigo-300 underline truncate">
                    {c.drawingName}
                  </Link>
                  <span className="ml-auto text-xs text-slate-500 dark:text-neutral-400 shrink-0">{timeAgo(c.createdAt)}</span>
                </div>
                <div className={`mt-0.5 text-slate-700 dark:text-neutral-300 ${c.undoneAt ? 'line-through opacity-60' : ''}`}>
                  {c.summary}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
