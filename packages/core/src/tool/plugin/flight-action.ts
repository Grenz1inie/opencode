export * as FlightActionTool from "./flight-action.js"

import { ToolFailure } from "@opencode/ai/effect"
import { FlightAction } from "@opencode/flight-action"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Config } from "../../config.js"
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
import { Flag } from "../../flag.js"
import { Permission } from "../../permission.js"

export const Plugin = {
  id: "opencode.tool.flight-action",
  effect: Effect.fn("FlightActionTool.Plugin")(function* (ctx: Context) {
    const config = yield* Config.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.tool.reload())
    const flags = yield* Flag.Service
    const permission = yield* Permission.Service
    const name = FlightAction.definition.name
    yield* ctx.tool
      .transform((editor) => {
        if (!flags.resolve(loaded.entries).flight_action.enabled) return
        editor.add({
          name,
          options: { codemode: false },
          description: "Find simulated flights for an origin city, destination city and date (YYYY-MM-DD).",
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
  }),
}
