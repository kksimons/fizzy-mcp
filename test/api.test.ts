import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Api from "../src/fizzy/api.js"
import { type FizzyClientService, nextLink, readPath, stripHtml } from "../src/fizzy/client.js"
import { FizzyApiError } from "../src/fizzy/errors.js"

// A tiny recording mock: routes are matched by path substring; the handler
// returns a JSON body, or an object describing status/location/link headers.
type Call = { method: string; path: string; body?: unknown }

function mockClient(
  handle: (call: Call) => unknown
): { client: FizzyClientService; calls: Call[] } {
  const calls: Call[] = []
  const client: FizzyClientService = {
    requestRaw: (method, path, body) => {
      calls.push({ method, path, body })
      const res = handle({ method, path, body })
      if (res && typeof res === "object" && "__error" in res) {
        return Effect.fail((res as { __error: FizzyApiError }).__error)
      }
      if (res && typeof res === "object" && ("__location" in res || "__link" in res || "__status" in res)) {
        const r = res as { __status?: number; __location?: string; __link?: string; body?: unknown }
        return Effect.succeed({
          status: r.__status ?? 200,
          json: r.body ?? null,
          location: r.__location ?? null,
          link: r.__link ?? null
        })
      }
      return Effect.succeed({ status: 200, json: res ?? null, location: null, link: null })
    }
  }
  return { client, calls }
}

/** Run an effect expected to succeed (throws with a clear cause if it fails). */
const run = Effect.runSync

/** Run an effect expected to fail, returning its typed error. */
const fail = <A, E>(eff: Effect.Effect<A, E>): E => Effect.runSync(Effect.flip(eff))

describe("pure helpers", () => {
  it("nextLink extracts the rel=next URL (quoted or bare)", () => {
    expect(nextLink("<https://x/y?page=2>; rel=\"next\", <https://x/y?page=1>; rel=\"prev\"")).toBe(
      "https://x/y?page=2"
    )
    expect(nextLink("<https://x/y?page=2>; rel=next")).toBe("https://x/y?page=2")
    expect(nextLink(null)).toBeNull()
    expect(nextLink("<https://x/y>; rel=\"prev\"")).toBeNull()
  })

  it("stripHtml converts fizzy HTML to plain text", () => {
    expect(stripHtml("<div class=\"action-text-content\"><p>Hello &amp; bye &quot;x&quot;</p></div>")).toBe(
      "Hello & bye \"x\""
    )
    expect(stripHtml(undefined)).toBe("")
  })

  it("readPath navigates nested objects/arrays", () => {
    expect(readPath({ a: [{ b: 7 }] }, ["a", 0, "b"])).toBe(7)
    expect(readPath({ a: null }, ["a", "b"])).toBeUndefined()
  })
})

describe("listBoards / findBoard", () => {
  it("lists boards and fuzzy-matches by name", () => {
    const { client } = mockClient(() => [
      { id: "b1", name: "Acme" },
      { id: "b2", name: "House Reno" }
    ])
    expect(run(Api.listBoards(client))).toEqual([
      { id: "b1", name: "Acme" },
      { id: "b2", name: "House Reno" }
    ])
    expect(run(Api.findBoard(client, "acme"))).toEqual({ id: "b1", name: "Acme" })
  })

  it("rejects an empty board name (would otherwise match the first board)", () => {
    const { client } = mockClient(() => [{ id: "b1", name: "Acme" }])
    expect(() => run(Api.findBoard(client, "   "))).toThrow()
  })

  it("fails helpfully when nothing matches", () => {
    const { client } = mockClient(() => [{ id: "b1", name: "Acme" }])
    expect(() => run(Api.findBoard(client, "nope"))).toThrow()
  })
})

describe("card summaries carry board + status", () => {
  it("classifies closed / postponed / column / triage and includes board", () => {
    const { client } = mockClient(() => [
      { number: 1, title: "Closed one", closed: true, board: { name: "Acme" }, tags: ["x"], url: "u1" },
      { number: 2, title: "Postponed", postponed: true, board: { name: "Acme" }, tags: [], url: "u2" },
      {
        number: 3,
        title: "In a column",
        column: { name: "In Progress" },
        board: { name: "Acme" },
        tags: [],
        url: "u3"
      },
      { number: 4, title: "Raw triage", board: { name: "Acme" }, tags: [], url: "u4" }
    ])
    const cards = run(Api.listCards(client, {})) as Api.CardSummary[]
    expect(cards.map((c) => `${c.number}:${c.status}:${c.board}`)).toEqual([
      "1:Done:Acme",
      "2:Not Now:Acme",
      "3:In Progress:Acme",
      "4:Triage:Acme"
    ])
  })
})

describe("createCard", () => {
  it("parses the card number from the Location header and echoes the board name", () => {
    const { client, calls } = mockClient(() => ({ __location: "https://fiz/cards/42", body: {} }))
    const res = run(Api.createCard(client, "b1", "Acme", "Replace the broken string"))
    expect(res).toEqual({
      number: 42,
      title: "Replace the broken string",
      board: "Acme",
      url: "https://fiz/cards/42"
    })
    expect(calls[0]?.body).toEqual({ card: { title: "Replace the broken string", status: "published" } })
  })

  it("fails when no number can be resolved", () => {
    const { client } = mockClient(() => ({ __location: "https://fiz/no-number-here" }))
    expect(() => run(Api.createCard(client, "b1", "Acme", "x"))).toThrow()
  })
})

describe("updateCard", () => {
  it("PUTs only the provided fields", () => {
    const { client, calls } = mockClient(() => null)
    run(Api.updateCard(client, 9, { title: "New title" }))
    const put = calls[0]
    expect(put?.method).toBe("PUT")
    expect(put?.path).toBe("/cards/9")
    expect(put?.body).toEqual({ card: { title: "New title" } })
  })
})

describe("moveCard target resolver", () => {
  const cardWithBoard = (boardId: string) => ({ board: { id: boardId, name: "Acme" }, number: 9, title: "x" })

  it("resolves a column name FIRST and triages with its id", () => {
    const { client, calls } = mockClient((c) => {
      if (c.method === "GET" && c.path.includes("/cards/9")) return cardWithBoard("b1")
      if (c.path.endsWith("/boards/b1/columns")) {
        return [
          { id: "col-ip", name: "In Progress" },
          { id: "col-blk", name: "Blocked" }
        ]
      }
      return null
    })
    const res = run(Api.moveCard(client, 9, "in progress")) as Api.MoveResult
    expect(res).toMatchObject({ number: 9, status: "In Progress" })
    expect(calls.find((c) => c.path.endsWith("/triage"))?.body).toEqual({ column_id: "col-ip" })
    expect(calls.some((c) => c.path.endsWith("/closure"))).toBe(false)
  })

  it("a real column wins over the 'done' keyword", () => {
    const { client, calls } = mockClient((c) => {
      if (c.method === "GET") return c.path.includes("/cards/9") ? cardWithBoard("b1") : [{ id: "cd", name: "Done" }]
      return null
    })
    const res = run(Api.moveCard(client, 9, "done")) as Api.MoveResult
    expect(res.status).toBe("Done")
    expect(calls.some((c) => c.path.endsWith("/triage"))).toBe(true)
    expect(calls.some((c) => c.path.endsWith("/closure"))).toBe(false)
  })

  it("falls back to closure when 'done' matches no column", () => {
    const { client, calls } = mockClient((c) => {
      if (c.method === "GET") {
        return c.path.includes("/cards/9")
          ? cardWithBoard("b1")
          : [{ id: "x", name: "In Progress" }]
      }
      return null
    })
    run(Api.moveCard(client, 9, "done"))
    expect(calls.some((c) => c.path.endsWith("/cards/9/closure"))).toBe(true)
  })

  it("falls back to not_now for postpone words", () => {
    const { client, calls } = mockClient((c) => {
      if (c.method === "GET") return c.path.includes("/cards/9") ? cardWithBoard("b1") : []
      return null
    })
    run(Api.moveCard(client, 9, "postpone"))
    expect(calls.some((c) => c.path.endsWith("/cards/9/not_now"))).toBe(true)
  })

  it("rejects an empty target and a non-matching name", () => {
    const { client } = mockClient((c) =>
      c.method === "GET" && c.path.includes("/cards/9") ? cardWithBoard("b1") : [{ id: "x", name: "In Progress" }]
    )
    expect(() => run(Api.moveCard(client, 9, "   "))).toThrow()
    expect(() => run(Api.moveCard(client, 9, "laundry"))).toThrow()
  })

  it("turns a missing card into a friendly 'No card #N' error", () => {
    const { client } = mockClient(() => ({ __error: FizzyApiError.notFound("/cards/99") }))
    expect(fail(Api.moveCard(client, 99, "done")).message).toBe("No card #99.")
  })
})

describe("addComment", () => {
  it("posts the body under comment.body (not content)", () => {
    const { client, calls } = mockClient(() => ({ __location: "https://fiz/cards/9/comments/c1" }))
    run(Api.addComment(client, 9, "looks good"))
    const post = calls[0]
    expect(post?.method).toBe("POST")
    expect(post?.path).toBe("/cards/9/comments")
    expect(post?.body).toEqual({ comment: { body: "looks good" } })
  })
})

describe("toggleTag", () => {
  it("strips a leading # in both the request and the result", () => {
    const { client, calls } = mockClient(() => null)
    const res = run(Api.toggleTag(client, 9, "#urgent")) as Api.TagResult
    expect(calls[0]?.body).toEqual({ tag_title: "urgent" })
    expect(res).toMatchObject({ number: 9, tag: "urgent" })
    expect(res.detail).toContain("'urgent'")
    expect(res.detail).not.toContain("#urgent")
  })
})

describe("pagination (getAll)", () => {
  it("follows Link rel=next across pages", () => {
    const { client, calls } = mockClient((c) => {
      if (c.path === "/boards") return { __link: "<https://x/page2>; rel=\"next\"", body: [{ id: "b1", name: "A" }] }
      if (c.path === "https://x/page2") return [{ id: "b2", name: "B" }]
      return null
    })
    expect(run(Api.listBoards(client))).toEqual([
      { id: "b1", name: "A" },
      { id: "b2", name: "B" }
    ])
    expect(calls.length).toBe(2)
  })

  it("fails loudly on a non-array response instead of returning []", () => {
    const { client } = mockClient(() => ({ error: "boom" }))
    expect(() => run(Api.listBoards(client))).toThrow()
  })
})

describe("output schemas decode their own shapes", () => {
  it("MoveResult round-trips", () => {
    const out = Schema.decodeUnknownSync(Api.MoveResult)({ number: 9, status: "done", detail: "ok" })
    expect(out.number).toBe(9)
  })
})

describe("FizzyApiError", () => {
  it("is a tagged error with helpers", () => {
    const e = FizzyApiError.notFound("missing")
    expect(e.status).toBe(404)
    expect(e._tag).toBe("FizzyApiError")
  })
})
