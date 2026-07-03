import * as Schema from "effect/Schema"

/**
 * The single typed failure every fizzy tool can produce.
 *
 * Because each tool declares `failure: FizzyApiError`, the @effect/ai toolkit
 * serializes a thrown instance straight into an MCP error result — so the
 * agent (bit) gets a clean, readable failure instead of a stack trace.
 */
export class FizzyApiError extends Schema.TaggedError<FizzyApiError>()("FizzyApiError", {
  status: Schema.Number,
  message: Schema.String
}) {
  static auth(message = "Unauthorized — check your FIZZY_TOKEN (needs a Read+Write token)") {
    return new FizzyApiError({ status: 401, message })
  }
  static notFound(message: string) {
    return new FizzyApiError({ status: 404, message })
  }
  static badStatus(status: number, body: string) {
    return new FizzyApiError({ status, message: body.slice(0, 500) || `HTTP ${status}` })
  }
  static network(detail: unknown) {
    return new FizzyApiError({ status: 0, message: `Network error: ${String(detail)}` })
  }
}
