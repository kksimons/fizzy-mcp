import { Tool, Toolkit } from "@effect/ai"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Api from "./fizzy/api.js"
import { FizzyClient } from "./fizzy/client.js"
import { FizzyApiError } from "./fizzy/errors.js"

/**
 * The fizzy MCP toolkit: task-oriented tools (not raw REST) so the agent loop
 * stays short and they map to how a person speaks. Each tool declares typed
 * `parameters`, `success`, and `failure: FizzyApiError`.
 *
 * Both `Tool.Readonly` and `Tool.Destructive` are set explicitly on every tool.
 * This matters: their defaults are `Readonly=false` / `Destructive=true`, so
 * leaving `Destructive` unset would emit `destructiveHint: true` even on reads.
 * These annotations become MCP `readOnlyHint`/`destructiveHint`, which agents
 * use to badge/disable tools.
 */

// A Fizzy card number: positive integer. The trailing annotations() overrides
// the `title` that Schema.positive()/int() bake in, so the agent-facing JSON
// Schema carries a clean label instead of "positive"/"int".
const CardNumber = Schema.Number.pipe(
  Schema.positive(),
  Schema.int(),
  Schema.annotations({ title: "Card number" })
)

const ListBoards = Tool.make("list_boards", {
  description: "List all Fizzy boards you can access (id + name). Read-only.",
  success: Schema.Array(Api.Board),
  failure: FizzyApiError
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

const ListColumns = Tool.make("list_columns", {
  description: "List the workflow columns on a board (the valid stages a card can move to). Read-only.",
  parameters: {
    board: Schema.String.annotations({ description: "Board name (fuzzy). Resolved at runtime; never hard-coded." })
  },
  success: Schema.Array(Api.Column),
  failure: FizzyApiError
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

const FindCards = Tool.make("find_cards", {
  description: "Search/list cards. Use to answer 'what's on <board>?' or 'any card about <topic>?'. Read-only.",
  parameters: {
    board: Schema.optional(Schema.String).annotations({ description: "Board name (fuzzy) to scope to." }),
    terms: Schema.optional(Schema.Array(Schema.String)).annotations({
      description: "Search terms (array of strings)."
    }),
    status: Schema.optional(
      Schema.Literal("all", "closed", "not_now", "stalled", "postponing_soon", "golden").annotations({
        description: "Filter bucket. Omit for all open cards."
      })
    )
  },
  success: Schema.Array(Api.CardSummary),
  failure: FizzyApiError
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

const GetCard = Tool.make("get_card", {
  description: "Get full detail for one card by its number. Read-only.",
  parameters: {
    card_number: CardNumber.annotations({ description: "The card number, e.g. 42" })
  },
  success: Api.CardDetail,
  failure: FizzyApiError
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

const CreateCard = Tool.make("create_card", {
  description: "Create a new card on a board. Returns its number and URL.",
  parameters: {
    board: Schema.String.annotations({ description: "Board name (fuzzy). Resolved at runtime; never hard-coded." }),
    title: Schema.String.annotations({ description: "The card title." }),
    description: Schema.optional(Schema.String).annotations({ description: "Optional description." })
  },
  success: Api.CreateCardResult,
  failure: FizzyApiError
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)

const UpdateCard = Tool.make("update_card", {
  description: "Update a card's title and/or description. At least one of title/description is required.",
  parameters: {
    card_number: CardNumber.annotations({ description: "The card number." }),
    title: Schema.optional(Schema.String).annotations({ description: "New title." }),
    description: Schema.optional(Schema.String).annotations({ description: "New description." })
  },
  success: Api.OkResult,
  failure: FizzyApiError
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)

const MoveCard = Tool.make("move_card", {
  description: "Move a card to a target. Give a column name (e.g. 'in progress', 'blocked', 'testing') to triage " +
    "into it, or 'done'/'complete' to close, or 'not now' to postpone. Column matching is fuzzy on " +
    "lowercased names; if unsure of valid columns, call list_columns first. A real column always wins " +
    "over the 'done'/'not now' keywords.",
  parameters: {
    card_number: CardNumber.annotations({ description: "The card number, e.g. 42" }),
    target: Schema.String.annotations({
      description: "Target: a column name, or 'done', or 'not now'."
    })
  },
  success: Api.MoveResult,
  failure: FizzyApiError
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)

const AddComment = Tool.make("add_comment", {
  description: "Add a comment to a card.",
  parameters: {
    card_number: CardNumber.annotations({ description: "The card number." }),
    body: Schema.String.annotations({ description: "The comment text." })
  },
  success: Api.OkResult,
  failure: FizzyApiError
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)

const ToggleTag = Tool.make("toggle_tag", {
  description: "Toggle a tag on or off for a card (created if it doesn't exist). Leading # is optional.",
  parameters: {
    card_number: CardNumber.annotations({ description: "The card number." }),
    tag: Schema.String.annotations({ description: "Tag title, e.g. 'bug' or '#urgent'." })
  },
  success: Api.TagResult,
  failure: FizzyApiError
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
// Note: intentionally NOT idempotent — a toggle flips state, so auto-retry
// would silently turn a tag back off. Idempotent defaults to false.

/** The full toolkit. */
export const FizzyToolkit = Toolkit.make(
  ListBoards,
  ListColumns,
  FindCards,
  GetCard,
  CreateCard,
  UpdateCard,
  MoveCard,
  AddComment,
  ToggleTag
)

/**
 * The handlers Layer. Built inside an Effect that requires {@link FizzyClient},
 * so each handler closes over the resolved client and returns an Effect with no
 * further context requirements. The output (the handlers context) is what
 * `McpServer.toolkit(FizzyToolkit)` consumes.
 */
export const FizzyToolkitLive = FizzyToolkit.toLayer(
  Effect.gen(function*() {
    const client = yield* FizzyClient
    yield* Effect.logInfo(`fizzy: registering ${Object.keys(FizzyToolkit.tools).length} tools`)
    return FizzyToolkit.of({
      list_boards: () => Api.listBoards(client),
      list_columns: ({ board }) =>
        Effect.gen(function*() {
          const b = yield* Api.findBoard(client, board)
          return yield* Api.listColumns(client, b.id)
        }),
      find_cards: ({ board, terms, status }) =>
        Effect.gen(function*() {
          let boardId: string | undefined
          if (board && board.trim()) {
            const b = yield* Api.findBoard(client, board)
            boardId = b.id
          }
          const indexedBy = status && status !== "all" ? status : undefined
          return yield* Api.listCards(client, { boardId, terms, indexedBy })
        }),
      get_card: ({ card_number }) => Api.getCard(client, card_number),
      create_card: ({ board, title, description }) =>
        Effect.gen(function*() {
          const b = yield* Api.findBoard(client, board)
          return yield* Api.createCard(client, b.id, b.name, title, description)
        }),
      update_card: ({ card_number, title, description }) => Api.updateCard(client, card_number, { title, description }),
      move_card: ({ card_number, target }) => Api.moveCard(client, card_number, target),
      add_comment: ({ card_number, body }) => Api.addComment(client, card_number, body),
      toggle_tag: ({ card_number, tag }) => Api.toggleTag(client, card_number, tag)
    })
  })
)
