import * as Logger from "effect/Logger"
import { appendFileSync } from "node:fs"

/**
 * A Logger that appends structured lines to a file. Bit spawns MCP servers with
 * stderr discarded, and @effect/ai's stdio layer already strips stdout loggers
 * to keep the JSON-RPC wire clean — so a file logger is the only way to see
 * what the server is doing while it's driven by an agent.
 *
 * Enabled only when FIZZY_MCP_LOG is set (to a file path).
 */
export function fileLogger(path: string): Logger.Logger<unknown, void> {
  return Logger.make(({ logLevel, message, date }) => {
    const text = typeof message === "string" ? message : JSON.stringify(message)
    const line = `${date.toISOString()} [${logLevel.label}] ${text}\n`
    try {
      appendFileSync(path, line)
    } catch {
      // Logging must never break the server.
    }
  })
}
