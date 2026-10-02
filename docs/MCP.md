# AI agents (MCP)

ExcaliDash exposes a [Model Context Protocol](https://modelcontextprotocol.io) endpoint so AI clients such as Claude Code can read and edit drawings.

- **Endpoint:** `https://<your-host>/api/mcp` (streamable HTTP).
- **Auth:** an ExcaliDash API key (Profile → API keys) sent as `Authorization: Bearer exd_…`. The agent gets exactly that user's access; it needs the `drawings:read` and `drawings:write` scopes.
- **Admin:** Admin → *AI Agents (MCP)* turns the endpoint on or off and shows connected sessions and recent AI edits.

## Connecting Claude Code

```bash
claude mcp add --transport http excalidash https://<your-host>/api/mcp --header "Authorization: Bearer <your API key>"
```

To keep the key out of Claude's config, use a `headersHelper` script that prints `{"Authorization": "Bearer …"}` instead of `--header`.

## Tools

| Tool | What it does |
| --- | --- |
| `list_drawings` | Drawings you own or that are shared with you |
| `read_drawing` | Joins the drawing as a live collaborator and returns its elements in compact form |
| `edit_drawing` | Applies add / update / delete operations as one undoable change |
| `undo_change` / `redo_change` | Reverts or re-applies an AI change (defaults to this session's latest) |
| `list_changes` | AI changes on a drawing, from any agent |
| `create_drawing` | Creates an empty drawing |
| `set_agent_name` | Renames the collaborator the session appears as |

`edit_drawing` understands labels inside shapes and on arrows (`label`), arrows attached to shapes (`startId` / `endId`), and keeps both in place when shapes move.

## Live collaboration and undo

Each MCP session appears in open editors as its own collaborator (avatar with a bot badge, named after the client, e.g. "Claude Code", "Claude Code 2") with a cursor. Edits are streamed element by element so people watching see them being made.

Every `edit_drawing` call is stored as a change set (`AgentChange`). It can be undone or redone:

- from the AI session (`undo_change` / `redo_change`),
- from the toast shown in the editor when the edit lands, or
- from the editor's **AI changes** panel (bot icon in the header).

Undo and redo only touch elements nobody has edited since; anything changed in the meantime is left alone and reported as skipped.
