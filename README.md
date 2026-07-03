# fizzy-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[Fizzy](https://github.com/basecamp/fizzy), the Kanban tool from 37signals. It
exposes your boards, cards, columns, comments and tags as tools an AI agent can
call — so you can ask any MCP-compatible assistant to create issues and move them
across your board.

Built with [Effect](https://effect.website) and
[`@effect/ai`](https://effect.website/docs/ai/introduction) for typed errors,
structured logging, and a clean service architecture. Speaks MCP over **stdio**
(newline-delimited JSON-RPC 2.0), so it works with any stdio MCP client — Claude
Desktop, Claude Code, Cursor, bit, and others.

```
You: "create a card 'Replace the broken string' on the Solar board"
Agent: ✅   → create_card → returns card #42
You: "move it to in progress"
Agent: ✅   → move_card(42, "in progress") → triaged to the In Progress column
You: "move it to done"
Agent: ✅   → move_card(42, "done") → card closed
```

## Requirements

- **Node.js 20+** (tested on Node 20 and 26)
- A **Fizzy** account — self-hosted or hosted at `app.fizzy.do`
- (To hack on it) [Bun](https://bun.sh) and/or npm

## Quick start

```bash
git clone <this repo> fizzy-mcp && cd fizzy-mcp
bun install            # or: npm install
bun run build          # tsgo (native TypeScript) → dist/
```

Then [get a Fizzy token](#1-get-a-fizzy-access-token) and
[connect your agent](#3-connect-it-to-an-agent).

## 1. Get a Fizzy access token

The server authenticates to Fizzy with a **personal access token**.

1. Open your Fizzy instance in a browser and go to your **profile**.
2. In the **API** section, click **Personal access tokens**.
3. Click **Generate new access token**.
4. Give it a description (e.g. `fizzy-mcp`) and choose **Read + Write**.
5. Copy the token — it's shown only once.

> Treat the token like a password. Anyone who has it can act on your behalf.

Verify it works (this also reveals your account slug, which the server can use):

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Accept: application/json" \
     https://your-fizzy.example.com/my/identity
```

## 2. Configure

The server reads everything from environment variables:

| Variable | Required | Description |
|---|---|---|
| `FIZZY_URL` | yes | Base URL of your Fizzy instance, e.g. `https://your-fizzy.example.com` (no trailing slash). |
| `FIZZY_TOKEN` | yes | A **Read + Write** personal access token. |
| `FIZZY_ACCOUNT_SLUG` | no | Your account slug, e.g. `/897362094`. If omitted, it's auto-discovered from `/my/identity` on the first tool call. |
| `FIZZY_MCP_LOG` | no | Path to a log file. Set this while debugging (many agents discard a server's stderr). |

## 3. Connect it to an agent

`fizzy-mcp` is a **stdio** server: the client launches it as a subprocess and
talks JSON-RPC over its stdin/stdout. Every client is configured the same way —
a `command`, optional `args`, and an `env` map.

### The launcher (recommended)

After building, there's an executable launcher at `bin/fizzy-mcp`. **Use this as
the command** rather than `node dist/index.js`. It has a `#!/bin/sh` shebang and
locates `node` itself — which matters because MCP clients launched from the
macOS GUI (bit, Claude Desktop, …) run with a minimal `PATH` that often omits
Homebrew/nvm/fnm, so a bare `node` or `npx` can fail with
*"No such file or directory"*. The launcher side-steps that entirely.

Point your client at the **absolute path** of the launcher:

```
<repo>/bin/fizzy-mcp
```

(with no args, and the `env` map below).

<details>
<summary>If your client <em>does</em> have <code>node</code> on its PATH</summary>

You can also run the server directly:

```bash
node /absolute/path/to/fizzy-mcp/dist/index.js
```

i.e. `command: "node"`, `args: ["/absolute/path/to/fizzy-mcp/dist/index.js"]`.
The launcher is still the safer default for GUI clients.
</details>

### bit

[bit](https://github.com/kksimons/bit) is a desktop agent that speaks MCP over stdio.
Registering **any** local stdio MCP server in bit works the same way:

1. Open the bit tray icon → **Settings → Connections**.
2. Scroll to the **Custom stdio server** form (under the preset gallery).
3. Fill in four fields and click **Add**:
   - **name** — a short id for the connection (used to namespace tools as `mcp__<name>__<tool>`).
   - **command** — the executable to launch. Use an **absolute path** (see the PATH note below).
   - **args** — space-separated args; leave empty if your `command` is a self-contained launcher.
   - **env** — one `KEY=VALUE` per line (the value is everything after the first `=`).
4. bit spawns the process, runs the `initialize` → `tools/list` handshake, and
   shows `connected · N tools`. Toggle individual tools on/off under **Manage tools**.

> **The macOS GUI-PATH gotcha.** bit is a GUI app, so it launches with a minimal
> `PATH` that usually omits `/opt/homebrew/bin`, `~/.nvm`, `~/.fnm`, etc. A bare
> `command: "node"` or `"npx"` fails with *"couldn't start 'node': No such file or
> directory"*. Two fixes:
> - Point **command** at an absolute launcher script (a `#!/bin/sh` file that
>   finds the runtime itself) — this is what `bin/fizzy-mcp` is; or
> - Point **command** at the absolute runtime path, e.g.
>   `/opt/homebrew/bin/node`, with `args` = the absolute path to your built entry.

> **Refreshing a connection.** bit caches each connection's tool list. If you
> rebuild the server or change its config, toggle the connection **Off → On** (or
> restart bit) so it re-spawns the process and re-fetches `tools/list`.

For **fizzy-mcp** specifically:

- **name:** `fizzy`
- **command:** `/absolute/path/to/fizzy-mcp/bin/fizzy-mcp`
- **args:** *(leave empty)*
- **env:**
  - `FIZZY_URL=https://your-fizzy.example.com`
  - `FIZZY_TOKEN=…`
  - `FIZZY_MCP_LOG=/tmp/fizzy-mcp.log` *(optional)*

Save, toggle Off → On, and it should show **`fizzy · connected · 9 tools`**.

### Claude Desktop / Claude Code

Edit `claude_desktop_config.json` (Claude Desktop → Settings → Developer → Edit
Config):

```jsonc
{
  "mcpServers": {
    "fizzy": {
      "command": "/absolute/path/to/fizzy-mcp/bin/fizzy-mcp",
      "env": {
        "FIZZY_URL": "https://your-fizzy.example.com",
        "FIZZY_TOKEN": "…"
      }
    }
  }
}
```

Restart Claude Desktop to pick it up.

### Any other MCP client

Provide the same pieces — `command` = the absolute launcher path, an `env` map
with at least `FIZZY_URL` and `FIZZY_TOKEN`, and leave `args` empty. If your
client lets you set a working directory, use the repo root.

### Manual smoke test

Drive the handshake by hand to confirm the server responds (the account slug is
resolved lazily, so this needs no network):

```bash
( printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  ; sleep 1 ) \
  | FIZZY_URL=https://your-fizzy.example.com FIZZY_TOKEN=x ./bin/fizzy-mcp
```

You should get two JSON-RPC responses: the `initialize` result and a `tools/list`
result listing all nine tools.

## Tools

All tools resolve names → IDs for you, so you can speak naturally. Errors come
back as structured MCP error results.

| Tool | Parameters | Notes |
|---|---|---|
| `list_boards` | — | Boards you can access. **read-only** |
| `list_columns` | `board` | Workflow columns on a board (the valid move targets). **read-only** |
| `find_cards` | `board?`, `terms?`, `status?` | Search/list cards. `status`: `all`/`closed`/`not_now`/`stalled`/`postponing_soon`/`golden`. **read-only** |
| `get_card` | `card_number` | Full detail for one card. **read-only** |
| `create_card` | `board`, `title`, `description?` | Creates a card, returns its number + URL. |
| `update_card` | `card_number`, `title?`, `description?` | Updates a card's title and/or description. |
| `move_card` | `card_number`, `target` | Move a card — see below. |
| `add_comment` | `card_number`, `body` | Comment on a card. |
| `toggle_tag` | `card_number`, `tag` | Toggle a tag on/off (created if new; leading `#` optional). |

### `move_card` target vocabulary

`move_card` resolves the board's **columns first** (by fuzzy name), so a real
column always wins. Only if no column matches do Fizzy's two non-column card
states apply:

- **Done**: `done`, `complete`, `completed`, `finished`, `closed`, `ship`, `resolved` → closes the card.
- **Not Now**: `not now`, `postpone`, `later`, `defer`, `snooze` → postpones the card.
- **Anything else**: matched (fuzzily) against the board's **column names** (e.g. `in progress`, `blocked`, `testing`) → triaged into that column. If nothing matches, the error lists the valid columns.

## Observability

`@effect/ai`'s stdio layer strips stdout loggers so the JSON-RPC wire stays clean,
and many clients discard a server's stderr. To see what the server is doing, set
`FIZZY_MCP_LOG` (shown above) and tail it:

```bash
tail -f /tmp/fizzy-mcp.log
```

You'll see startup (client ready, tools registered) and, on the first tool call,
the resolved account slug.

## Troubleshooting

- **`connected · 0 tools`** — most likely the client cached a stale connection
  (the server registers all 9 tools at startup). Toggle the connection Off → On,
  or restart the client. Also confirm you ran `bun run build` and pointed the
  client at `bin/fizzy-mcp` (not the source).
- **`couldn't start 'node'` / `'npx'`** — you're running a GUI client that can't
  find `node` on its minimal PATH. Use the **launcher** (`bin/fizzy-mcp`) as the
  command instead of `node`/`npx`.
- **`Unauthorized`** — your `FIZZY_TOKEN` is wrong, expired, or read-only.
  Regenerate a **Read + Write** token.
- **`Could not resolve account slug`** — `/my/identity` didn't return an account.
  Set `FIZZY_ACCOUNT_SLUG` explicitly (the numeric slug from any Fizzy URL).
- **Tool calls time out** — check the `FIZZY_MCP_LOG`; confirm `FIZZY_URL` is
  reachable from the machine running the server.

## Development & tooling

Type-checking and emitting use **tsgo** (`@typescript/native-preview`, the native
Go TypeScript compiler) — fast and current. Linting uses ESLint 10 +
`typescript-eslint` + `@effect/eslint-plugin`'s `dprint` rule (deterministic
formatting: no semicolons, double quotes, 2-space). Tests use `@effect/vitest`.

```bash
bun run typecheck   # tsgo --noEmit
bun run lint:fix    # eslint --fix (formats with dprint)
bun run test        # vitest (operations exercised against an injected mock client)
bun run check       # all of the above + build, gated for CI
```

> The `typescript` package is kept as a devDependency only because
> `typescript-eslint`'s parser depends on it as a library — the project itself
> type-checks and builds with tsgo, never `tsc`.

## Project structure

```
bin/
  fizzy-mcp            # launcher: resolves node for GUI clients, then runs dist/
src/
  index.ts            # entry: wires FizzyClient + toolkit + McpServer.layerStdio
  tools.ts            # the 8 MCP tools (Tool.make + Toolkit + handlers Layer)
  logging.ts          # optional file logger
  fizzy/
    client.ts         # FizzyClient service: HTTP, auth, pagination, lazy account discovery
    api.ts            # typed fizzy operations + output schemas (the tool contracts)
    errors.ts         # FizzyApiError — the single typed failure every tool can return
test/
  api.test.ts         # operations exercised against an injected mock client (no network)
eslint.config.js      # flat config: typescript-eslint + @effect/dprint formatter
vitest.config.ts      # test runner config
```

**Nothing about your Fizzy instance is hard-coded.** Board IDs, column IDs, card
numbers and the account slug are all resolved at runtime: boards/columns by fuzzy
name match, the account slug from `/my/identity` (or `FIZZY_ACCOUNT_SLUG`), and
card numbers from the API. Rename a board or column in Fizzy and the tools keep
working. (Only Fizzy's two non-column states — "done" → close, "not now" →
postpone — map to fixed API endpoints, since those are Fizzy semantics, not board
data.)

## Build your own local MCP server

This repo is a small, complete template for wrapping **any** REST API as a local
stdio MCP server with Effect. To adapt it to a different service:

1. **Swap the client.** Edit `src/fizzy/client.ts`:
   - Put your base URL / auth in `fizzyConfig` (read from env with `Config.*`).
   - Rewrite `requestRaw`/`fetchJson` to call your API. Keep the shape — return
     `{ json, location, link }` and fail with a typed error — and do any
     one-time setup (like account discovery) **lazily**, not at construction, so
     tools register instantly at startup.

2. **Swap the operations.** Edit `src/fizzy/api.ts`:
   - Define an output `Schema.Struct` for each operation (these double as the
     tool's `success` contract).
   - Implement each operation as a function `(client, …args) => Effect<Result, YourError>`.

3. **Define the tools.** Edit `src/tools.ts`:
   - `Tool.make("name", { description, parameters: { …Schema fields… }, success, failure })`.
   - Annotate each with `.annotate(Tool.Readonly, true)` for pure reads, or
     `.annotate(Tool.Destructive, false)` for safe writes. These become MCP
     `readOnlyHint`/`destructiveHint`, which agents use to badge/disable tools.
   - Group them with `Toolkit.make(…)`, then provide handlers via
     `toolkit.toLayer(Effect.gen(() => { const client = yield* YourClient; … }))`.

4. **Wire it up.** `src/index.ts` is the pattern — you usually won't change it:

   ```ts
   const ServerLayer = McpServer.toolkit(YourToolkit).pipe(
     Layer.provide(YourToolkitLive),   // handlers (needs YourClient)
     Layer.provide(YourClientLive),    // the HTTP client
     Layer.provide(McpServer.layerStdio({
       name: "your-service", version: "1.0.0",
       stdin: NodeStream.stdin, stdout: NodeSink.stdout,
     })),
   )
   Layer.launch(ServerLayer).pipe(NodeRuntime.runMain)
   ```

### Why Effect here

- **Typed errors for free.** Each tool declares `failure: YourError`; a thrown
  instance is serialized straight into an MCP error result the agent can read.
- **Clean wire.** `McpServer.layerStdio` removes stdout loggers automatically, so
  logging can't corrupt the JSON-RPC stream the client reads.
- **Validation.** `Schema` validates tool parameters (input) and results (output),
  and generates the JSON Schema clients see in `tools/list`.

> Note: `@effect/ai` also has an HTTP (Streamable) transport, but it currently
> emits JSON-RPC batches that some clients reject (see
> [effect#6274](https://github.com/Effect-TS/effect/issues/6274)). The **stdio**
> transport used here is unaffected.

## License

MIT
