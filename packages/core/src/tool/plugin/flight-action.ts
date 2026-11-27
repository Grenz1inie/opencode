export * as FlightActionTool from "./flight-action.js"

import { ToolFailure } from "@opencode/ai/effect"
import { FlightAction } from "@opencode/flight-action"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Tool } from "@opencode/schema/tool"
import { Form } from "../../form.js"
import { Config } from "../../config.js"
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
import { Flag } from "../../flag.js"
import { Permission } from "../../permission.js"

export class CancelledError extends Schema.TaggedError<CancelledError>()("FlightActionTool.CancelledError", {}) {
  override get message() {
    return "The user cancelled the flight search"
  }
}

export const Plugin = {
  id: "opencode.tool.flight-action",
  effect: Effect.fn("FlightActionTool.Plugin")(function* (ctx: Context) {
    const config = yield* Config.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.tool.reload())
    const flags = yield* Flag.Service
    const permission = yield* Permission.Service
    const forms = yield* Form.Service
    const name = FlightAction.definition.name
    yield* ctx.tool
      .transform((editor) => {
        if (!flags.resolve(loaded.entries).flight_action.enabled) return
        editor.add({
          name,
          options: { codemode: false },
          description:
            "Find simulated flights. Call this tool with the cities and date the user supplied. Omit unknown fields so the tool can show a form. Do not guess a missing travel date or ask for it in chat.",
          input: FlightAction.Input,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                ...Permission.invocation(context),
              }).pipe(Effect.mapError((error) => new ToolFailure({ message: "Permission denied: find_flights", error })))
              yield* Effect.logDebug("Flight search target invoked", { callID: context.id, ...input })
              const result = yield* Effect.try({
                try: () => FlightAction.run(input),
                catch: (error) => new ToolFailure({ message: "Invalid flight search result", error }),
              })
              return {
                content: JSON.stringify(result.model ?? {}),
                metadata: result.user ? { flightAction: result.user } : {},
              }
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
