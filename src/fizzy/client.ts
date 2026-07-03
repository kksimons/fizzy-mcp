import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { FizzyApiError } from "./errors.js"

export interface FizzyResponse {
  readonly status: number
  /** `null` for 204 responses, or when the body isn't JSON. */
  readonly json: unknown
  /** Value of the `Location` response header, if present. */
  readonly location: string | null
  /** Value of the `Link` response header, if present (used for pagination). */
  readonly link: string | null
}

/**
 * FizzyClient — a thin, typed HTTP client for the Fizzy REST API.
 *
 * `requestRaw` takes a path *suffix* (e.g. `/boards`, `/cards/42`); the account
 * slug is prepended lazily, resolved on first use and memoized via
 * `Effect.cached` (which also de-duplicates concurrent first calls). This keeps
 * layer construction I/O-free so the server registers its tools immediately on
 * startup (no race with the first `tools/list`), and surfaces any
 * auth/discovery error on the call that triggers it rather than crashing at boot.
 */
export interface FizzyClientService {
  readonly requestRaw: (
    method: string,
    pathSuffix: string,
    body?: unknown
  ) => Effect.Effect<FizzyResponse, FizzyApiError>
}

export class FizzyClient extends Context.Tag("FizzyClient")<FizzyClient, FizzyClientService>() {}

const fizzyConfig = Config.all({
  baseUrl: Config.string("FIZZY_URL"),
  token: Config.string("FIZZY_TOKEN"),
  accountSlug: Config.option(Config.string("FIZZY_ACCOUNT_SLUG"))
})

/** Statuses that mean the token was rejected. */
const AUTHISH = new Set([401, 403])
/** Redirect statuses that can point at the login page. */
const REDIRECT = new Set([301, 302, 307, 308])

export const FizzyClientLive = Layer.effect(
  FizzyClient,
  Effect.gen(function*() {
    const cfg = yield* fizzyConfig
    const baseUrl = cfg.baseUrl.replace(/\/+$/, "")
    const token = cfg.token

    // One core fetch+parse routine; takes an absolute URL.
    const fetchJson = (
      method: string,
      url: string,
      body: unknown
    ): Effect.Effect<FizzyResponse, FizzyApiError> =>
      Effect.tryPromise({
        try: async (): Promise<FizzyResponse> => {
          const res = await fetch(url, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              ...(body === undefined ? {} : { "Content-Type": "application/json" })
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            // Don't auto-follow the login redirect on auth failures.
            redirect: "manual"
          })
          const location = res.headers.get("Location")
          const link = res.headers.get("Link")
          const isLoginRedirect = REDIRECT.has(res.status) && location != null && /\/session(?:\?|$|\/)/.test(location)
          if (isLoginRedirect || AUTHISH.has(res.status)) throw FizzyApiError.auth()
          if (res.status === 404) throw FizzyApiError.notFound(url)
          if (res.status === 429) {
            const retryAfter = res.headers.get("Retry-After")
            throw new FizzyApiError({
              status: 429,
              message: `Rate limited${retryAfter ? `; retry after ${retryAfter}s` : ""}`
            })
          }
          if (res.status === 204) return { status: res.status, json: null, location, link }

          const text = await res.text().catch(() => "")
          // Any other 4xx/5xx is a hard error; non-login 3xx (rare for Fizzy) is fine.
          if (res.status >= 400) throw FizzyApiError.badStatus(res.status, text)

          let json: unknown = null
          const trimmed = text.trim()
          const ct = res.headers.get("Content-Type") ?? ""
          if (trimmed && (ct.includes("json") || trimmed.startsWith("[") || trimmed.startsWith("{"))) {
            try {
              json = JSON.parse(trimmed)
            } catch {
              // Leave json null if the body isn't valid JSON.
            }
          }
          return { status: res.status, json, location, link }
        },
        catch: (e: unknown): FizzyApiError => (e instanceof FizzyApiError ? e : FizzyApiError.network(e))
      })

    // Account slug: explicit env wins; otherwise discover once, lazily + memoized.
    // Effect.cached memoizes the success, de-duplicates concurrent first callers,
    // and retries on failure (so a transient /my/identity error isn't cached).
    const withSlash = (s: string): string => (s.startsWith("/") ? s : `/${s}`)
    const discoverSlug: Effect.Effect<string, FizzyApiError> = Option.match(cfg.accountSlug, {
      onSome: (slug) => Effect.succeed(withSlash(slug)),
      onNone: () =>
        Effect.gen(function*() {
          const res = yield* fetchJson("GET", `${baseUrl}/my/identity`, undefined)
          const raw = readPath(res.json, ["accounts", 0, "slug"])
          if (typeof raw === "string" && raw.length > 0) return withSlash(raw)
          return yield* Effect.fail(
            new FizzyApiError({
              status: 0,
              message: "Could not resolve account slug from /my/identity. Set FIZZY_ACCOUNT_SLUG explicitly."
            })
          )
        })
    })

    const resolveSlug = yield* discoverSlug.pipe(
      Effect.tap((slug) => Effect.logInfo(`fizzy: account resolved as ${slug}`)),
      Effect.cached
    )

    const requestRaw = (
      method: string,
      pathSuffix: string,
      body?: unknown
    ): Effect.Effect<FizzyResponse, FizzyApiError> =>
      Effect.gen(function*() {
        // Absolute URLs (pagination next-links) are used as-is; suffixes are
        // prefixed with the base URL + resolved account slug.
        const slug = yield* resolveSlug
        const url = /^https?:\/\//i.test(pathSuffix) ? pathSuffix : `${baseUrl}${slug}${pathSuffix}`
        return yield* fetchJson(method, url, body)
      })

    yield* Effect.logInfo(`fizzy: client ready (${baseUrl}); account resolves on first request`)

    return FizzyClient.of({ requestRaw })
  })
)

// ---- tiny defensive accessors (fizzy shapes are stable but we never trust them blindly) ----

/** Read a value at a path through nested objects/arrays. */
export function readPath(root: unknown, path: ReadonlyArray<string | number>): unknown {
  let cur: unknown = root
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[String(key)]
  }
  return cur
}

/** Extract the first `rel="next"` URL from an HTTP Link header (quoted or bare). */
export function nextLink(link: string | null): string | null {
  if (!link) return null
  const match = link.match(/<([^>]+)>;\s*rel\s*=\s*"?next"?\b/i)
  return match?.[1] ?? null
}

/** Crude HTML→text for voice-friendly output (we never render fizzy's HTML). */
export function stripHtml(html: unknown): string {
  if (typeof html !== "string") return ""
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
}
