import { McpServer } from "@effect/ai"
import { NodeRuntime, NodeSink, NodeStream } from "@effect/platform-node"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import pkg from "../package.json" with { type: "json" }
import { FizzyClientLive } from "./fizzy/client.js"
import { fileLogger } from "./logging.js"
import { FizzyToolkit, FizzyToolkitLive } from "./tools.js"

/**
 * fizzy-mcp — a Model Context Protocol server for Fizzy, driven over stdio.
 *
 * Layers, bottom to top:
 *   FizzyClientLive            — HTTP client (config + account discovery)
 *   FizzyToolkitLive           — tool handlers, needs FizzyClient
 *   McpServer.toolkit(...)     — registers the tools with the MCP registry
 *   McpServer.layerStdio(...)  — the JSON-RPC run loop over stdin/stdout
 *
 * @effect/ai's stdio layer already strips stdout loggers so the wire stays
 * clean (the agent reads newline-delimited JSON-RPC from stdout). We add an
 * optional file logger (FIZZY_MCP_LOG) for observability, since clients like
 * bit discard stderr.
 */

/** A no-op logger layer unless FIZZY_MCP_LOG is set (to a file path). */
const FileLoggerLayer = Layer.unwrapEffect(
  Effect.gen(function*() {
    const path = yield* Config.option(Config.string("FIZZY_MCP_LOG"))
    if (path._tag === "None") return Layer.empty
    return Logger.add(fileLogger(path.value))
  })
)

const ServerLayer = McpServer.toolkit(FizzyToolkit).pipe(
  Layer.provide(FizzyToolkitLive),
  Layer.provide(FizzyClientLive),
  Layer.provide(
    McpServer.layerStdio({
      name: "fizzy",
      version: pkg.version,
      stdin: NodeStream.stdin,
      stdout: NodeSink.stdout
    })
  ),
  Layer.provide(FileLoggerLayer)
)

Layer.launch(ServerLayer).pipe(NodeRuntime.runMain)
