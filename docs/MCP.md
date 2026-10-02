# AI agents (MCP)

ExcaliDash exposes a [Model Context Protocol](https://modelcontextprotocol.io) endpoint so AI clients such as Claude can read and edit drawings. Each AI session shows up in open drawings as a live collaborator, and every AI edit can be undone.

- **Endpoint:** `https://<your-host>/api/mcp` (streamable HTTP), where `<your-host>` is the address you open ExcaliDash at. The Admin page shows the exact URL.
- **Auth:** an ExcaliDash API key sent as `Authorization: Bearer exd_…`. The AI gets exactly that user's access.
- **Admin:** Admin → *AI Agents (MCP)* turns the endpoint on or off and shows connected sessions and recent AI edits.

## Setup

Every option below needs the same two things first.

### 1. Get an account

Self sign-up is usually off. An admin creates the account from **Admin → New User** and sends the login details.

### 2. Create an API key

1. Log in to ExcaliDash and open **Profile → API keys**.
2. Create a key with a name that says where it will be used (e.g. "Claude Desktop – laptop"), keeping all four scopes ticked (`drawings:read`, `drawings:write`, `collections:read`, `collections:write`).
3. Copy the key (it starts with `exd_`). It is shown only once; if you lose it, revoke it and create a new one.

Then connect with **one** of the options below (A–C for Claude, D for Codex).

### Option A: Claude Desktop connector (recommended, no installs)

1. In Claude Desktop open **Settings → Connectors** and click **Add → Add custom connector**.
2. Fill in the dialog:

   | Field | What to enter / select |
   | --- | --- |
   | Name | `ExcaliDash` (any name works) |
   | Remote MCP server URL | `https://<your-host>/api/mcp` |
   | **Authentication** | **No sign-in**. ExcaliDash uses an API key, not OAuth. |
   | **OAuth client** | Leave as is; it is not used with *No sign-in*. |
   | **Request headers** → Header name | `Authorization` |
   | **Request headers** → Value | `Bearer exd_your_key_here` (the word `Bearer`, one space, then your key) |
   | **Required** | Ticked |

   Leave **Advanced** alone.
3. Click **Add**. ExcaliDash should appear in the connectors list without a *Reconnect* or warning icon.
4. In a chat, open the tools menu under the message box and make sure **ExcaliDash** is switched on.

The header value is stored by Claude and not shown again. To change the key later, remove the connector and add it again.

### Option B: Claude Code (terminal, or Claude Desktop's Code tab)

Run once in a terminal:

```bash
claude mcp add --transport http --scope user excalidash https://<your-host>/api/mcp --header "Authorization: Bearer exd_your_key_here"
```

`--scope user` makes it available in every project. Check it with `claude mcp list`; `excalidash` should show as connected.

To keep the key out of Claude's config, store it in a file and use a `headersHelper` script that prints `{"Authorization": "Bearer <key>"}` instead of `--header`.

### Option C: Claude Desktop config file (manual fallback)

Use this if the connector dialog in Option A is not available in your version of Claude Desktop. It runs a small local bridge (`mcp-remote`), so it needs [Node.js](https://nodejs.org) 18 or newer (install the LTS version with default options).

1. In Claude Desktop open **Settings → Developer → Edit Config**. This opens the folder with `claude_desktop_config.json`:
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
2. Add the `excalidash` entry (keep any servers already listed under `mcpServers`):

   ```json
   {
     "mcpServers": {
       "excalidash": {
         "command": "npx",
         "args": [
           "-y",
           "mcp-remote",
           "https://<your-host>/api/mcp",
           "--header",
           "Authorization:${AUTH_HEADER}"
         ],
         "env": {
           "AUTH_HEADER": "Bearer exd_your_key_here"
         }
       }
     }
   }
   ```

   Keep `Authorization:${AUTH_HEADER}` exactly as written, with no space after the colon (a workaround for a Windows bug with spaces in arguments). The space belongs inside `AUTH_HEADER`, between `Bearer` and the key.
3. Fully quit Claude Desktop (Windows: right-click the tray icon → Quit; macOS: ⌘Q) and open it again.

### Option D: Codex (CLI, IDE extension or desktop app)

The Codex CLI, IDE extension and desktop app share one config file, `~/.codex/config.toml` (`%USERPROFILE%\.codex\config.toml` on Windows), so set it up once.

**Recommended: CLI command plus an environment variable**

```bash
codex mcp add excalidash --url https://<your-host>/api/mcp --bearer-token-env-var EXCALIDASH_API_KEY
```

Then save the key in that variable and open a new terminal:

- Windows: `setx EXCALIDASH_API_KEY "exd_your_key_here"`
- macOS / Linux: add `export EXCALIDASH_API_KEY="exd_your_key_here"` to `~/.zshrc` or `~/.bashrc`

Check it with `codex mcp list`, or `/mcp` inside Codex.

**Alternative: key inline in `config.toml`.** Apps started from the dock or Start menu may not see terminal environment variables. Putting the header in the config works everywhere (the key is then stored in that file in plain text):

```toml
[mcp_servers.excalidash]
url = "https://<your-host>/api/mcp"
http_headers = { "Authorization" = "Bearer exd_your_key_here" }
```

The Admin page's *AI Agents (MCP)* card shows all of these options in **Claude Code** and **Codex** tabs, with the endpoint filled in.

### Check that it works

Ask Claude: *"List my ExcaliDash drawings."* The first time, Claude asks for permission to use the tool. Allow it.

Then open a drawing in the browser next to Claude and ask for a change, for example *"In my Roadmap drawing, add a box called 'Review' between steps 3 and 4."* You will see Claude join the drawing and draw the change.

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| Connector shows an error or *Reconnect* | Check the header: name `Authorization`, value `Bearer ` + key, with one space. Re-add the connector if unsure. |
| "Invalid or revoked API key" | The key was mistyped or revoked. Create a new one in Profile → API keys. |
| "MCP access is disabled by an administrator" | An admin must switch **AI Agents (MCP)** to **Enabled** on the Admin page. |
| Option C: server never appears | Make sure Node.js is installed (restart the computer after installing), and check **Settings → Developer** for a JSON error such as a missing comma. |
| Claude can't find a drawing | The key's user must own the drawing or have it shared with them. |

### Security

The API key gives the AI that user's access to their drawings. Use a separate key per device so one can be revoked without affecting the others. If a device is lost or shared, revoke its key in **Profile → API keys**; access stops immediately. Admins can see who is connected and every AI edit on the Admin page.

## Tools

| Tool | What it does |
| --- | --- |
| `list_drawings` | Drawings you own or that are shared with you |
| `read_drawing` | Joins the drawing as a live collaborator and returns its elements in compact form; can be limited to a `frame`, an `area` or `ids`, or `summaryOnly` |
| `edit_drawing` | Applies operations as one undoable change (see below) |
| `export_drawing` | Renders the drawing, one frame or some elements to PNG (returned as an image) or SVG |
| `point_at` | Moves the AI's cursor to elements or a point and highlights them, like a laser pointer |
| `undo_change` / `redo_change` | Reverts or re-applies an AI change (defaults to this session's latest) |
| `list_changes` | AI changes on a drawing, from any agent |
| `create_drawing` / `rename_drawing` | Creates an empty drawing / renames one |
| `set_agent_name` | Renames the collaborator the session appears as |

### What `edit_drawing` can do

- **Element types:** rectangle, ellipse, diamond, text, arrow, line, freedraw (pen strokes from points), frame (named container), image and embeddable (web embed).
- **Operations:** `add`, `update`, `delete`, `assign_frame`, `erase` (delete everything touching an area) and `reorder` (bring to front / send to back). `update` and `delete` take `ids` to apply one change to many elements.
- **Canvas:** `background` sets the canvas colour; open editors update live.
- **Labels and arrows:** `label` puts text inside a shape or on an arrow; `startId` / `endId` attach arrows to shapes, images or embeds, and both stay in place when shapes move.
- **Frames:** add a frame, then give elements its id as `frameId`, or use `assign_frame` to put in everything inside the frame (or an area) at once. Contents are clipped to the frame and move with it; deleting a frame keeps its contents.
- **Images:** `image.url` (public https) or `image.dataUrl`; PNG, JPEG, GIF, WebP or SVG up to 5 MB. Remote URLs on private networks are refused.

### Token use

Replies are minified, and style values most elements share are sent once as `styleDefaults` instead of on every element (about half the size of a plain dump on a typical chart). Read just the frame or area being worked on, use `ids` for bulk changes, and skip re-reading after an edit: `edit_drawing` already returns what it created.

Exports are rendered on the server with the same hand-drawn style as the editor; text uses a standard sans font rather than Excalidraw's handwriting font.

## Live collaboration and undo

Each MCP session appears in open editors as its own collaborator (avatar with a bot badge, named after the client, e.g. "Claude Code", "Claude Code 2") with a cursor. Edits are streamed element by element so people watching see them being made.

Every `edit_drawing` call is stored as a change set (`AgentChange`). It can be undone or redone:

- from the AI session (`undo_change` / `redo_change`, or just ask Claude to undo),
- from the toast shown in the editor when the edit lands, or
- from the editor's **AI changes** panel (bot icon in the header).

Undo and redo only touch elements nobody has edited since; anything changed in the meantime is left alone and reported as skipped.
