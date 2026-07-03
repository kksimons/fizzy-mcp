import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type FizzyClientService, nextLink, readPath, stripHtml } from "./client.js"
import { FizzyApiError } from "./errors.js"

// ============================================================================
// Output schemas (also used as each tool's `success`). Co-located with the
// operations that produce them so data and contract stay in sync.
// ============================================================================

export const Board = Schema.Struct({
  id: Schema.String,
  name: Schema.String
})
export type Board = Schema.Schema.Type<typeof Board>

export const Column = Schema.Struct({
  id: Schema.String,
  name: Schema.String
})
export type Column = Schema.Schema.Type<typeof Column>

export const CardSummary = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  /** Human-readable location: a column name, or "Done" / "Not Now" / "Triage". */
  status: Schema.String,
  board: Schema.String,
  tags: Schema.Array(Schema.String),
  url: Schema.String
})
export type CardSummary = Schema.Schema.Type<typeof CardSummary>

export const CardDetail = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  description: Schema.String,
  status: Schema.String,
  board: Schema.String,
  closed: Schema.Boolean,
  tags: Schema.Array(Schema.String),
  url: Schema.String
})
export type CardDetail = Schema.Schema.Type<typeof CardDetail>

export const CreateCardResult = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  board: Schema.String,
  url: Schema.String
})
export type CreateCardResult = Schema.Schema.Type<typeof CreateCardResult>

export const MoveResult = Schema.Struct({
  number: Schema.Number,
  status: Schema.String,
  detail: Schema.String
})
export type MoveResult = Schema.Schema.Type<typeof MoveResult>

export const OkResult = Schema.Struct({
  number: Schema.Number,
  detail: Schema.String
})
export type OkResult = Schema.Schema.Type<typeof OkResult>

export const TagResult = Schema.Struct({
  number: Schema.Number,
  tag: Schema.String,
  detail: Schema.String
})
export type TagResult = Schema.Schema.Type<typeof TagResult>

// ============================================================================
// Status vocabulary for move_card. These map to Fizzy's two non-column card
// states (Done = closed, Not Now = postponed). Column names are resolved
// dynamically per board (see moveCard), and win over these reserved words, so a
// board with a column literally named "Park" triages there rather than
// postponing. Words are normalized (lowercase, separators stripped).
// ============================================================================

const norm = (s: string): string => s.trim().toLowerCase().replace(/[\s_-]+/g, "")

const DONE_WORDS = new Set(
  ["done", "complete", "completed", "finish", "finished", "closed", "close", "ship", "shipped", "resolve", "resolved"]
    .map(norm)
)
const NOT_NOW_WORDS = new Set(
  ["not now", "postpone", "postponed", "later", "defer", "deferred", "snooze", "park"].map(norm)
)

// ============================================================================
// Operations. Each takes the FizzyClient service value and returns an Effect
// with no context requirements, so tool handlers can close over `client`.
// ============================================================================

/** GET /:account/boards — list boards. */
export function listBoards(client: FizzyClientService) {
  return getAll<Board>(client, `/boards`, (raw) => ({
    id: String(readPath(raw, ["id"]) ?? ""),
    name: String(readPath(raw, ["name"]) ?? "")
  }))
}

/** Find a board by (fuzzy) name. */
export function findBoard(client: FizzyClientService, name: string) {
  return Effect.gen(function*() {
    const want = norm(name)
    if (want === "") {
      return yield* Effect.fail(new FizzyApiError({ status: 422, message: "A board name is required." }))
    }
    const boards = yield* listBoards(client)
    const found = fuzzyFind(boards, (b) => b.name, want)
    if (found) return found
    return yield* Effect.fail(
      new FizzyApiError({
        status: 404,
        message: `No board matching '${name}'. Boards: ${boards.map((b) => b.name).join(", ")}`
      })
    )
  })
}

/** GET /:account/boards/:id/columns — list the workflow columns on a board. */
export function listColumns(client: FizzyClientService, boardId: string) {
  return getAll<Column>(client, `/boards/${boardId}/columns`, (raw) => ({
    id: String(readPath(raw, ["id"]) ?? ""),
    name: String(readPath(raw, ["name"]) ?? "")
  }))
}

/** GET /:account/cards — list/search cards with optional filters. */
export function listCards(
  client: FizzyClientService,
  opts: { boardId?: string; terms?: ReadonlyArray<string>; indexedBy?: string }
) {
  const params = new URLSearchParams()
  if (opts.boardId) params.set("board_ids[]", opts.boardId)
  for (const t of opts.terms ?? []) params.append("terms[]", t)
  if (opts.indexedBy) params.set("indexed_by", opts.indexedBy)
  const qs = params.toString()
  const path = `/cards${qs ? `?${qs}` : ""}`
  return getAll<CardSummary>(client, path, summarizeCard)
}

/** GET /:account/cards/:n — full detail for one card. */
export function getCard(client: FizzyClientService, cardNumber: number) {
  return Effect.gen(function*() {
    const res = yield* client.requestRaw("GET", `/cards/${cardNumber}`).pipe(
      Effect.catchTag("FizzyApiError", (e: FizzyApiError) =>
        e.status === 404
          ? Effect.fail(new FizzyApiError({ status: 404, message: `No card #${cardNumber}.` }))
          : Effect.fail(e))
    )
    return shapeDetail(res.json)
  })
}

/** POST /:account/boards/:id/cards — create a card, returning its number + url. */
export function createCard(
  client: FizzyClientService,
  boardId: string,
  boardName: string,
  title: string,
  description?: string
) {
  return Effect.gen(function*() {
    const res = yield* client.requestRaw("POST", `/boards/${boardId}/cards`, {
      card: { title, ...(description ? { description } : {}), status: "published" }
    })
    // Fizzy returns 201 + a Location header (.../cards/<number>); the body may
    // or may not include the card JSON. Resolve the number from whichever is present.
    const fromLoc = parseCardNumber(res.location)
    const fromBody = readPath(res.json, ["number"])
    const num = fromLoc ?? (typeof fromBody === "number" && fromBody > 0 ? fromBody : null)
    if (num === null) {
      return yield* Effect.fail(
        new FizzyApiError({
          status: 0,
          message: `Card created but its number couldn't be resolved (Location: ${res.location ?? "none"})`
        })
      )
    }
    const url = String(readPath(res.json, ["url"]) ?? res.location ?? "")
    return { number: num, title, board: boardName, url } satisfies CreateCardResult
  })
}

/** PUT /:account/cards/:n — update a card's title and/or description. */
export function updateCard(
  client: FizzyClientService,
  cardNumber: number,
  fields: { title?: string; description?: string }
) {
  return Effect.gen(function*() {
    const card: Record<string, string> = {}
    if (fields.title !== undefined) card.title = fields.title
    if (fields.description !== undefined) card.description = fields.description
    yield* client.requestRaw("PUT", `/cards/${cardNumber}`, { card })
    return { number: cardNumber, detail: `Card #${cardNumber} updated.` } satisfies OkResult
  })
}

/**
 * Move a card to a target. Columns on the card's board are resolved FIRST (by
 * fuzzy name), so a real column always wins. Only if no column matches do the
 * reserved state-words apply: "done"/"complete"/… → close, "not now"/… →
 * postpone.
 */
export function moveCard(client: FizzyClientService, cardNumber: number, target: string) {
  return Effect.gen(function*() {
    const want = norm(target)
    if (want === "") {
      return yield* Effect.fail(new FizzyApiError({ status: 422, message: "A target status is required." }))
    }

    const cardRes = yield* client.requestRaw("GET", `/cards/${cardNumber}`).pipe(
      Effect.catchTag(
        "FizzyApiError",
        (e: FizzyApiError) =>
          e.status === 404
            ? Effect.fail(new FizzyApiError({ status: 404, message: `No card #${cardNumber}.` }))
            : Effect.fail(e)
      )
    )
    const card = cardRes.json
    const boardId = String(readPath(card, ["board", "id"]) ?? "")
    if (!boardId) {
      return yield* Effect.fail(
        new FizzyApiError({ status: 404, message: `Card #${cardNumber} has no board to resolve columns against.` })
      )
    }

    // 1. Try to match a real column on the board.
    const columns = yield* listColumns(client, boardId)
    const col = matchColumn(columns, want)
    if (col) {
      yield* client.requestRaw("POST", `/cards/${cardNumber}/triage`, { column_id: col.id })
      return {
        number: cardNumber,
        status: col.name,
        detail: `Card #${cardNumber} moved to ${col.name}.`
      } satisfies MoveResult
    }

    // 2. Fall back to Fizzy's non-column states.
    if (DONE_WORDS.has(want)) {
      yield* client.requestRaw("POST", `/cards/${cardNumber}/closure`)
      return { number: cardNumber, status: "done", detail: `Card #${cardNumber} closed (Done).` } satisfies MoveResult
    }
    if (NOT_NOW_WORDS.has(want)) {
      yield* client.requestRaw("POST", `/cards/${cardNumber}/not_now`)
      return {
        number: cardNumber,
        status: "not now",
        detail: `Card #${cardNumber} moved to Not Now.`
      } satisfies MoveResult
    }

    // 3. Nothing matched — help the agent pick a valid target.
    return yield* Effect.fail(
      new FizzyApiError({
        status: 404,
        message: `No column matching '${target}'. Columns: ${
          columns.map((c) => c.name).join(", ")
        }. (Or use 'done' or 'not now'.)`
      })
    )
  })
}

/** POST /:account/cards/:n/comments — add a comment. */
export function addComment(client: FizzyClientService, cardNumber: number, text: string) {
  return Effect.gen(function*() {
    yield* client.requestRaw("POST", `/cards/${cardNumber}/comments`, { comment: { body: text } })
    return { number: cardNumber, detail: `Comment added to card #${cardNumber}.` } satisfies OkResult
  })
}

/** POST /:account/cards/:n/taggings — toggle a tag on/off. */
export function toggleTag(client: FizzyClientService, cardNumber: number, tag: string) {
  return Effect.gen(function*() {
    const clean = tag.replace(/^#/, "")
    yield* client.requestRaw("POST", `/cards/${cardNumber}/taggings`, { tag_title: clean })
    return {
      number: cardNumber,
      tag: clean,
      detail: `Toggled tag '${clean}' on card #${cardNumber}.`
    } satisfies TagResult
  })
}

// ============================================================================
// Internals
// ============================================================================

/** Exact-then-substring fuzzy match on a normalized name (shared by findBoard/matchColumn). */
function fuzzyFind<A>(items: ReadonlyArray<A>, getName: (a: A) => string, want: string): A | undefined {
  const exact = items.find((a) => norm(getName(a)) === want)
  if (exact) return exact
  return items.find((a) => {
    const n = norm(getName(a))
    return n.length > 0 && (n.includes(want) || want.includes(n))
  })
}

function matchColumn(columns: ReadonlyArray<Column>, want: string): Column | undefined {
  return want === "" ? undefined : fuzzyFind(columns, (c) => c.name, want)
}

function parseCardNumber(location: string | null): number | null {
  if (!location) return null
  const match = location.match(/\/cards\/(\d+)/)
  const n = match?.[1]
  return n ? Number(n) : null
}

/** A card's human-readable location across Fizzy's states. */
function cardStatus(raw: unknown): string {
  if (readPath(raw, ["closed"]) === true) return "Done"
  if (readPath(raw, ["postponed"]) === true) return "Not Now"
  const col = readPath(raw, ["column", "name"])
  return typeof col === "string" && col.length > 0 ? col : "Triage"
}

function summarizeCard(raw: unknown): CardSummary {
  const tags = readPath(raw, ["tags"])
  return {
    number: Number(readPath(raw, ["number"]) ?? 0),
    title: String(readPath(raw, ["title"]) ?? ""),
    status: cardStatus(raw),
    board: String(readPath(raw, ["board", "name"]) ?? ""),
    tags: Array.isArray(tags) ? tags.map(String) : [],
    url: String(readPath(raw, ["url"]) ?? "")
  }
}

function shapeDetail(raw: unknown): CardDetail {
  const tags = readPath(raw, ["tags"])
  return {
    number: Number(readPath(raw, ["number"]) ?? 0),
    title: String(readPath(raw, ["title"]) ?? ""),
    description: stripHtml(readPath(raw, ["description"])) || stripHtml(readPath(raw, ["description_html"])),
    status: cardStatus(raw),
    board: String(readPath(raw, ["board", "name"]) ?? ""),
    closed: readPath(raw, ["closed"]) === true,
    tags: Array.isArray(tags) ? tags.map(String) : [],
    url: String(readPath(raw, ["url"]) ?? "")
  }
}

/**
 * Follow Fizzy's paginated list endpoints (Link: rel="next"), mapping each raw
 * item through `map`. Bounded by both page count and item count to keep tool
 * output within an agent's context; logs a warning if truncated. Fails loudly on
 * a non-array response rather than silently returning an empty list.
 */
const MAX_PAGES = 12
const MAX_ITEMS = 50

function getAll<A>(
  client: FizzyClientService,
  firstPath: string,
  map: (raw: unknown) => A
): Effect.Effect<A[], FizzyApiError> {
  return Effect.gen(function*() {
    const out: A[] = []
    let path: string | null = firstPath
    let pages = 0
    let truncated = false
    while (path !== null && pages < MAX_PAGES) {
      if (out.length >= MAX_ITEMS) {
        truncated = true
        break
      }
      const res = yield* client.requestRaw("GET", path)
      if (res.json === null) break
      if (!Array.isArray(res.json)) {
        return yield* Effect.fail(
          new FizzyApiError({ status: 502, message: `Expected a list from ${path}, got ${typeof res.json}.` })
        )
      }
      for (const item of res.json) {
        if (out.length >= MAX_ITEMS) {
          truncated = true
          break
        }
        out.push(map(item))
      }
      const nxt = nextLink(res.link)
      // Guard against a self-referencing next link (would loop until MAX_PAGES).
      path = nxt && nxt !== path ? nxt : null
      pages++
    }
    if (truncated) {
      yield* Effect.logWarning(`fizzy: list truncated at ${out.length} items (${path ?? firstPath})`)
    }
    return out
  })
}
