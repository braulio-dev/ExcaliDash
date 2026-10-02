import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy } from 'lucide-react';

// Per-client setup instructions for the MCP endpoint, one tab per AI client.

const labelClassName = 'block text-sm font-bold text-slate-700 dark:text-neutral-300 mb-2';
const KEY_PLACEHOLDER = 'exd_your_key_here';
const GUIDE_URL = 'https://github.com/braulio-dev/ExcaliDash/blob/main/docs/MCP.md#setup';

export const CopyBlock: React.FC<{ label?: string; value: string }> = ({ label, value }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      {label ? <div className={labelClassName}>{label}</div> : null}
      <div className="flex items-stretch gap-2">
        <code className="flex-1 min-w-0 px-3 py-2.5 rounded-xl border-2 border-slate-200 dark:border-neutral-700 bg-slate-50 dark:bg-neutral-800 text-xs text-slate-800 dark:text-neutral-200 font-mono whitespace-pre-wrap break-all">
          {value}
        </code>
        <button
          type="button"
          title="Copy"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="px-3 rounded-xl border-2 border-black dark:border-neutral-600 text-slate-700 dark:text-neutral-200 hover:bg-slate-100 dark:hover:bg-neutral-800 transition-colors"
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
    </div>
  );
};

const Option: React.FC<{ title: string; badge?: string; children: React.ReactNode }> = ({ title, badge, children }) => (
  <div className="rounded-xl border-2 border-slate-200 dark:border-neutral-700 p-4 space-y-3">
    <div className="flex items-center gap-2">
      <h3 className="text-sm font-bold text-slate-900 dark:text-white">{title}</h3>
      {badge ? (
        <span className="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide border bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800">
          {badge}
        </span>
      ) : null}
    </div>
    {children}
  </div>
);

const Steps: React.FC<{ start?: number; children: React.ReactNode }> = ({ start, children }) => (
  <ol start={start} className="list-decimal pl-5 space-y-1 text-sm text-slate-700 dark:text-neutral-300">{children}</ol>
);

const FieldTable: React.FC<{ rows: [string, React.ReactNode][] }> = ({ rows }) => (
  <div className="rounded-xl border-2 border-slate-200 dark:border-neutral-700 divide-y-2 divide-slate-100 dark:divide-neutral-800 text-sm">
    {rows.map(([field, value]) => (
      <div key={field} className="grid grid-cols-1 sm:grid-cols-3 gap-1 sm:gap-3 px-3 py-2">
        <div className="font-bold text-slate-700 dark:text-neutral-300">{field}</div>
        <div className="sm:col-span-2 text-slate-800 dark:text-neutral-200">{value}</div>
      </div>
    ))}
  </div>
);

const mono = (text: string) => <code className="font-mono text-xs">{text}</code>;

const ClaudeSetup: React.FC<{ endpoint: string }> = ({ endpoint }) => (
  <div className="space-y-4">
    <Option title="Claude Desktop: custom connector" badge="Recommended">
      <Steps>
        <li>Open <strong>Settings → Connectors</strong> and choose <strong>Add → Add custom connector</strong>.</li>
        <li>Fill it in as below, then click <strong>Add</strong>.</li>
        <li>In a chat, switch <strong>ExcaliDash</strong> on in the tools menu under the message box.</li>
      </Steps>
      <FieldTable
        rows={[
          ['Name', 'ExcaliDash'],
          ['Remote MCP server URL', mono(endpoint)],
          ['Authentication', <><strong>No sign-in</strong> (ExcaliDash uses an API key, not OAuth)</>],
          ['OAuth client', 'Leave as is; not used with No sign-in'],
          ['Request header name', mono('Authorization')],
          ['Request header value', <>{mono(`Bearer ${KEY_PLACEHOLDER}`)} (one space after Bearer)</>],
          ['Required', 'Ticked'],
        ]}
      />
    </Option>
    <Option title="Claude Code: terminal or the Desktop Code tab">
      <CopyBlock
        value={`claude mcp add --transport http --scope user excalidash ${endpoint} --header "Authorization: Bearer ${KEY_PLACEHOLDER}"`}
      />
      <p className="text-xs text-slate-600 dark:text-neutral-400">
        Check it with {mono('claude mcp list')}; {mono('excalidash')} should show as connected.
      </p>
    </Option>
    <Option title="Claude Desktop: config file (fallback, needs Node.js 18+)">
      <Steps>
        <li>Open <strong>Settings → Developer → Edit Config</strong> and add this to {mono('claude_desktop_config.json')}.</li>
        <li>Fully quit Claude Desktop and open it again.</li>
      </Steps>
      <CopyBlock
        value={JSON.stringify(
          {
            mcpServers: {
              excalidash: {
                command: 'npx',
                args: ['-y', 'mcp-remote', endpoint, '--header', 'Authorization:${AUTH_HEADER}'],
                env: { AUTH_HEADER: `Bearer ${KEY_PLACEHOLDER}` },
              },
            },
          },
          null,
          2,
        )}
      />
    </Option>
  </div>
);

const CodexSetup: React.FC<{ endpoint: string }> = ({ endpoint }) => (
  <div className="space-y-4">
    <p className="text-sm text-slate-700 dark:text-neutral-300">
      The Codex CLI, IDE extension and desktop app share {mono('~/.codex/config.toml')}
      {' '}({mono('%USERPROFILE%\\.codex\\config.toml')} on Windows), so set it up once.
    </p>
    <Option title="Codex CLI command + environment variable" badge="Recommended">
      <Steps>
        <li>Add the server; Codex reads the key from an environment variable:</li>
      </Steps>
      <CopyBlock value={`codex mcp add excalidash --url ${endpoint} --bearer-token-env-var EXCALIDASH_API_KEY`} />
      <Steps start={2}>
        <li>Save the key in that variable, then open a new terminal.</li>
      </Steps>
      <CopyBlock label="Windows" value={`setx EXCALIDASH_API_KEY "${KEY_PLACEHOLDER}"`} />
      <CopyBlock label="macOS / Linux (add to ~/.zshrc or ~/.bashrc)" value={`export EXCALIDASH_API_KEY="${KEY_PLACEHOLDER}"`} />
      <p className="text-xs text-slate-600 dark:text-neutral-400">
        Check it with {mono('codex mcp list')}, or {mono('/mcp')} inside Codex.
      </p>
    </Option>
    <Option title="config.toml with the key inline (for the desktop app or IDE)">
      <p className="text-xs text-slate-600 dark:text-neutral-400">
        Apps started from the dock or Start menu may not see terminal environment variables. Putting the
        header in the config works everywhere; the key is then stored in that file in plain text.
      </p>
      <CopyBlock
        value={`[mcp_servers.excalidash]\nurl = "${endpoint}"\nhttp_headers = { "Authorization" = "Bearer ${KEY_PLACEHOLDER}" }`}
      />
    </Option>
  </div>
);

const TABS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
] as const;

export const McpSetupTabs: React.FC<{ endpoint: string }> = ({ endpoint }) => {
  // Nothing open until an admin picks a client; picking it again closes it.
  const [tab, setTab] = useState<(typeof TABS)[number]['id'] | null>(null);
  return (
    <div>
      <div className={labelClassName}>Connect an AI client</div>
      <p className="text-xs text-slate-600 dark:text-neutral-400 mb-3">
        First create an API key in <Link to="/profile" className="font-bold underline">Profile → API keys</Link> and
        use it in place of {mono(KEY_PLACEHOLDER)}. The AI gets exactly that person's access. More detail in the{' '}
        <a href={GUIDE_URL} target="_blank" rel="noreferrer" className="font-bold underline">setup guide</a>.
      </p>
      <div role="tablist" className="flex gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab((current) => (current === t.id ? null : t.id))}
            className={`px-4 py-2 rounded-xl border-2 text-sm font-bold transition-all ${
              tab === t.id
                ? 'border-black dark:border-neutral-500 bg-indigo-50 dark:bg-neutral-800 text-indigo-700 dark:text-indigo-300 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)]'
                : 'border-slate-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-slate-600 dark:text-neutral-300 hover:border-slate-400'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab ? (
        <div role="tabpanel" className="mt-4">
          {tab === 'claude' ? <ClaudeSetup endpoint={endpoint} /> : <CodexSetup endpoint={endpoint} />}
        </div>
      ) : null}
    </div>
  );
};
