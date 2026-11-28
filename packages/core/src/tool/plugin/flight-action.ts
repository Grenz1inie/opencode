export * as FlightActionTool from "./flight-action.js"

import { ToolFailure } from "@opencode/ai/effect"
import { ActionOutput, CaseAction, CustomerReviews, FlightAction } from "@opencode/flight-action"
import { FlightReschedule } from "@opencode/schema/flight-reschedule"
import { SessionMessage } from "@opencode/schema/session-message"
import { SessionID } from "@opencode/schema/session-id"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Option, Schema } from "effect"
import { Tool } from "@opencode/schema/tool"
import { Form } from "../../form.js"
import { Config } from "../../config.js"
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
import { Flag } from "../../flag.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"

export class CancelledError extends Schema.TaggedError<CancelledError>()("FlightActionTool.CancelledError", {
  action: Schema.optionalKey(Schema.String),
}) {
  override get message() {
    return "The user cancelled the " + (this.action ?? "flight search")
  }
}

const readSessionID = Schema.decodeUnknownOption(SessionID)
const readMessageID = Schema.decodeUnknownOption(SessionMessage.ID)
const readView = Schema.decodeUnknownOption(FlightAction.View)
const readRevision = Schema.decodeUnknownOption(FlightReschedule.Result)
const readPresentation = Schema.decodeUnknownOption(ActionOutput.Presentation)
const readResults = Schema.decodeUnknownOption(FlightAction.Results)
const readFailure = Schema.decodeUnknownOption(FlightAction.Input)

function firstOutputs(metadata: Schema.JsonObject | undefined) {
  if (metadata && Object.hasOwn(metadata, "actionOutput")) {
    const presentation = Option.getOrUndefined(readPresentation(metadata.actionOutput))
    return presentation?.widget === FlightAction.widget ? presentation.outputs : undefined
  }

  const legacy = Option.getOrUndefined(readView(metadata?.flightAction))
  return legacy ? { results: legacy.attributes } : undefined
}

function cardKey(card: FlightReschedule.Card) {
  return "flight-date:" + JSON.stringify([card.sessionID, card.messageID, card.callID])
}

export const Plugin = {
  id: "opencode.tool.flight-action",
  effect: Effect.fn("FlightActionTool.Plugin")(function* (ctx: Context) {
    const config = yield* Config.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.tool.reload())
    const flags = yield* Flag.Service
    const permission = yield* Permission.Service
    const forms = yield* Form.Service
    const sessions = yield* Session.Service
    const name = FlightAction.definition.name
    const enabled = () => flags.resolve(loaded.entries).flight_action.enabled

    const permit = (request: Pick<Permission.AssertInput, "sessionID" | "agent" | "source" | "metadata">) =>
      permission.assert({ ...request, action: name, resources: ["*"], save: ["*"] })

    const execute = Effect.fn("FlightActionTool.execute")(function* (
      input: FlightAction.Input,
      callID: string,
      attempt: FlightAction.Attempt = "search",
    ) {
      yield* Effect.logDebug("Flight search target invoked", { callID, ...input, attempt })
      return yield* Effect.try({
        try: () => FlightAction.run(input, { attempt }),
        catch: (error) => new ToolFailure({ message: "Flight search failed", error, metadata: { flightFailure: input } }),
      })
    })

    const askDate = Effect.fn("FlightActionTool.askDate")(function* (
      sessionID: SessionID,
      request: NonNullable<ReturnType<typeof FlightAction.reschedule>>,
    ) {
      const answer = yield* forms.ask({
        sessionID,
        title: "Change flight date",
        metadata: {
          kind: "action",
          operation: "reschedule",
          message: [request.values.originCity, request.values.destinationCity].join(" → "),
        },
        fields: request.fields,
      }).pipe(Effect.orDie)
      if (answer.status === "cancelled") return null

      return yield* Schema.decodeUnknownEffect(FlightAction.Input)({
        ...request.values,
        dateOfTravel: answer.answer.dateOfTravel,
      }).pipe(Effect.orDie)
    })

    const active = new Set<string>()
    const read = Effect.fn("FlightActionTool.readRevision")(function* (key: string) {
      return Option.getOrNull(readRevision(yield* ctx.storage.get(key)))
    })
    const ownsSession = Effect.fnUntraced(function* (sessionID: SessionID) {
      const session = yield* sessions.get(sessionID).pipe(Effect.option)
      if (Option.isNone(session)) return false

      const location = session.value.location
      return location.directory === ctx.location.directory && location.workspaceID === ctx.location.workspaceID
    })

    const original = Effect.fn("FlightActionTool.originalCard")(function* (card: FlightReschedule.Card) {
      const sessionID = Option.getOrUndefined(readSessionID(card.sessionID))
      const messageID = Option.getOrUndefined(readMessageID(card.messageID))
      if (!sessionID || !messageID || !(yield* ownsSession(sessionID))) return

      const message = yield* sessions.message({ sessionID, messageID })
      if (message?.type !== "assistant") return

      const tool = message.content.find(
        (part) => part.type === "tool" && part.id === card.callID && part.name === name,
      )
      if (tool?.type !== "tool") return

      if (tool.state.status === "error") {
        const failure = Option.getOrUndefined(readFailure(tool.state.metadata?.flightFailure))
        if (failure) return { sessionID, agent: message.agent, failure }
        return
      }
      if (tool.state.status !== "completed") return

      const outputs = firstOutputs(tool.state.metadata)
      const view = outputs && FlightAction.bind(outputs).view
      if (!view) return

      return { sessionID, agent: message.agent, view }
    })

    const publish = (card: FlightReschedule.Card, result: FlightReschedule.Result): Effect.Effect<void> =>
      rpc.events.emit("changed", { card, result }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Failed to publish revised flight result", { cause })),
      )

    const rpc = yield* ctx.rpc.register(FlightReschedule.Definition, {
      get: (card, call) =>
        Effect.gen(function* () {
          if (!(yield* original(card)))
            return yield* Effect.fail(call.error("Unavailable", "This flight result is unavailable.", null))

          return yield* read(cardKey(card))
        }),
      change: ({ card, revision, operation }, call) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const key = cardKey(card)
            if (active.has(key)) return false
            active.add(key)
            return true
          }),
          (claimed) =>
            Effect.gen(function* () {
              if (!claimed || !enabled())
                return yield* Effect.fail(call.error("Unavailable", "This action is unavailable.", null))
              const source = yield* original(card)
              if (!source)
                return yield* Effect.fail(call.error("Unavailable", "This flight result is unavailable.", null))

              const key = cardKey(card)
              const previous = yield* read(key)
              const view = previous ? FlightAction.bind(previous.outputs).view : source.view
              const request = view && FlightAction.reschedule(view, operation)
              const failed = previous ? Option.getOrUndefined(readFailure(previous.failure)) : source.failure
              const retry = FlightAction.isRetry(operation) ? failed : undefined
              if (revision !== (previous?.revision ?? card.callID) || (!request && !retry))
                return yield* Effect.fail(
                  call.error("Unavailable", "This action is unavailable for the current flight result.", null),
                )

              const input = retry ?? (request && (yield* askDate(source.sessionID, request)))
              if (!input) return null

              const attempt = retry ? "retry" : "reschedule"
              const permitted = yield* permit({
                sessionID: source.sessionID,
                agent: source.agent,
                source: { type: "tool", messageID: card.messageID, id: card.callID },
                metadata: { operation: attempt, input },
              }).pipe(
                Effect.as(true),
                Effect.catchTags({
                  "Permission.BlockedError": () => Effect.succeed(false),
                  "Permission.CorrectedError": () => Effect.succeed(false),
                  "Session.NotFoundError": () =>
                    Effect.fail(call.error("Unavailable", "This flight result is unavailable.", null)),
                }),
                Effect.catchDefect((cause) =>
                  cause instanceof Permission.DeclinedError ? Effect.succeed(false) : Effect.die(cause),
                ),
              )
              if (!permitted) return null

              const callID = crypto.randomUUID()
              return yield* Effect.gen(function* () {
                const result: FlightReschedule.Result = yield* execute(input, callID, attempt).pipe(
                  Effect.match({
                    onSuccess: (action) => ({ revision: callID, outputs: action.tool.metadata.actionOutput.outputs }),
                    onFailure: () => ({ revision: callID, outputs: {}, failure: input }),
                  }),
                )

                // Keep the assistant's original tool output intact; only the visible outcome is revised.
                yield* ctx.storage.set(key, result)
                yield* publish(card, result)
                return result
              }).pipe(Effect.uninterruptible)
            }),
          (claimed) => Effect.sync(() => {
            if (claimed) active.delete(cardKey(card))
          }),
        ),
    }).pipe(Effect.orDie)
    yield* ctx.tool
      .transform((editor) => {
        if (!enabled()) return
        editor.add({
          name,
          options: { codemode: false },
          description:
            "Find simulated flights. Call this tool with the cities and date the user supplied. Omit unknown fields so the tool can show a form. Do not guess a missing travel date or ask for it in chat. A failed search can be retried from its result card.",
          input: FlightAction.Input,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permit(Permission.invocation(context)).pipe(
                Effect.mapError((error) => new ToolFailure({ message: "Permission denied: find_flights", error })),
              )
              return (yield* execute(input, context.id)).tool
            }),
        })
        editor.add({
          name: "read_flight_result",
          options: { codemode: false, permission: name },
          description:
            "Read the saved outcome of the most recent flight search card in this session, including date changes or failures. Use this when the user asks about that result.",
          input: Schema.Struct({}),
          execute: (_, context) =>
            Effect.gen(function* () {
              yield* permit(Permission.invocation(context)).pipe(
                Effect.mapError((error) => new ToolFailure({ message: "Permission denied: read_flight_result", error })),
              )

              if (!(yield* ownsSession(context.sessionID)))
                return yield* new ToolFailure({ message: "This flight result is unavailable." })

              const limit = 20
              let after: SessionMessage.ID | undefined
              while (true) {
                const messages = yield* sessions
                  .messages({
                    sessionID: context.sessionID,
                    type: "assistant",
                    order: "desc",
                    limit,
                    cursor: after ? { id: after, direction: "next" } : undefined,
                  })
                  .pipe(Effect.mapError((error) => new ToolFailure({ message: "Unable to read flight search history", error })))

                for (const message of messages) {
                  if (message.type !== "assistant") continue

                  for (const tool of message.content.toReversed()) {
                    if (tool.type !== "tool" || tool.name !== name) continue
                    if (tool.state.status !== "completed" && tool.state.status !== "error") continue

                    const card = { sessionID: context.sessionID, messageID: message.id, callID: tool.id }
                    const revision = yield* read(cardKey(card))
                    const failed = revision?.failure ??
                      (tool.state.status === "error" && !revision ? tool.state.metadata?.flightFailure : undefined)
                    if (Option.isSome(readFailure(failed))) return { content: JSON.stringify({ status: "failed" }) }

                    const saved = revision?.outputs ??
                      (tool.state.status === "completed" ? firstOutputs(tool.state.metadata) : undefined)
                    if (!saved && tool.state.status === "error") continue

                    const results = Option.getOrUndefined(readResults(saved?.results))
                    if (!results) return yield* new ToolFailure({ message: "This flight result is unavailable." })

                    const outputs = ActionOutput.project(FlightAction.definition.outputs, { results })
                    return { content: JSON.stringify(outputs.model) }
                  }
                }

                after = messages.at(-1)?.id
                if (messages.length < limit || !after) break
              }

              return yield* new ToolFailure({ message: "No completed flight search in this session." })
            }),
        })
        editor.add({
          name: CaseAction.action.name,
          options: { codemode: false },
          description: "Open the simulated support case form. Prefill known case details and omit unknown values.",
          input: CaseAction.Draft,
          execute: (draft, context) =>
            Effect.gen(function* () {
              const plan = CaseAction.prepare(draft)
              if (plan.kind === "unavailable") return yield* Effect.fail(new ToolFailure({ message: plan.message }))

              const state = yield* forms
                .ask({
                  sessionID: context.sessionID,
                  title: CaseAction.action.title,
                  fields: plan.fields,
                  metadata: {
                    kind: "action",
                    action: CaseAction.action.name,
                    ...(plan.kind === "registered" ? { editor: plan.editor } : {}),
                    tool: { messageID: context.messageID, id: context.id },
                  },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error })))
              if (state.status === "cancelled") return yield* Effect.die(new CancelledError({ action: "case submission" }))

              const input = yield* Effect.try({
                try: () => CaseAction.fromAnswer(state.answer),
                catch: (error) => new ToolFailure({ message: "Invalid support case details", error }),
              })
              yield* permission.assert({
                action: CaseAction.action.name,
                resources: ["*"],
                save: ["*"],
                ...Permission.invocation(context),
              }).pipe(Effect.mapError((error) => new ToolFailure({ message: "Permission denied: submit_case", error })))

              yield* Effect.logDebug("Simulated case target invoked", { callID: context.id })
              return CaseAction.run(input)
            }),
        })
        editor.add({
          name: CustomerReviews.name,
          options: { codemode: false },
          description: "Show sample customer reviews. Set empty to true if the user asks for an empty review list.",
          input: CustomerReviews.Input,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: CustomerReviews.name,
                resources: ["*"],
                save: ["*"],
                ...Permission.invocation(context),
              }).pipe(Effect.mapError((error) => new ToolFailure({ message: "Permission denied: get_customer_reviews", error })))
              return CustomerReviews.run(input)
            }),
        })
      })
      .pipe(Effect.orDie)

    yield* ctx.session.hook("context", (event) =>
      Effect.sync(() => {
        const tool = event.tools[name]
        if (!tool || !Array.isArray(tool.input.required)) return
        tool.input = { ...tool.input, required: tool.input.required.filter((key) => !FlightAction.formable(key)) }
      }),
    )

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        if (event.tool !== name || event.info?.input !== FlightAction.Input) return
        const prepared = yield* Effect.try({
          try: () => FlightAction.prepare(event.input),
          catch: (cause) => new Tool.Error({ message: cause instanceof Error ? cause.message : "Invalid flight search input" }),
        })
        const [first, ...rest] = prepared.fields
        if (!first) return
        const state = yield* forms.ask({
          sessionID: event.sessionID,
          title: "Flight search details",
          metadata: {
            kind: "action",
            tool: { messageID: event.messageID, id: event.id },
            message: [prepared.values.originCity, prepared.values.destinationCity].filter(Boolean).join(" → "),
          },
          fields: [first, ...rest],
        }).pipe(Effect.mapError((cause) => new Tool.Error({ message: cause.message })))
        if (state.status === "cancelled") return yield* Effect.die(new CancelledError())
        event.input = { ...prepared.values, ...state.answer }
      }),
    )
  }),
}
