export * as ActionTool from "./action.js"

import { ActionOutput } from "@opencode/flight-action"
import type { Catalog, Definition } from "@opencode/plugin/action"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import type { Config } from "../config.js"
import { ConfigEntryObserver } from "../config/plugin/entry-observer.js"
import type { Flag } from "../flag.js"
import { Permission } from "../permission.js"
import { normalizedName } from "./runtime.js"

type Host = Pick<Context, "tool" | "permission" | "event"> & {
  readonly config: Config.Interface
  readonly flags: Flag.Interface
}

export const register = Effect.fn("ActionTool.register")(function* (catalog: Catalog, host: Host) {
  const tools = yield* Effect.forEach(catalog.actions, (definition) =>
    compile(catalog, definition, host.permission).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Skipping invalid Action registration", {
          action: definition.name,
          error: error.message,
        }).pipe(Effect.as(undefined)),
      ),
    ),
  )
  const loaded = yield* ConfigEntryObserver.observe(host.config, host.event, host.tool.reload())
  return yield* host.tool.transform((editor) => {
    if (!host.flags.resolve(loaded.entries).action_ui.enabled) return
    tools.forEach((tool) => {
      if (tool) editor.add(tool)
    })
  })
})

const compile = Effect.fnUntraced(function* (catalog: Catalog, definition: Definition, permission: Context["permission"]) {
  const target = Object.hasOwn(catalog.targets, definition.target) ? catalog.targets[definition.target] : undefined
  if (typeof target !== "function") return yield* new Tool.Error({ message: `Unknown target "${definition.target}" at target` })

  const input = yield* fields(catalog, "inputs", definition.inputs)
  const output = yield* fields(catalog, "outputs", definition.outputs)
  const action = normalizedName(definition)

  return {
    name: definition.name,
    description: definition.description,
    options: { codemode: false },
    input,
    execute: (input: Schema.JsonObject, context: Tool.Context) =>
      Effect.gen(function* () {
        yield* permission.assert({ action, resources: ["*"], save: ["*"], ...Permission.invocation(context) })
        const raw = yield* target(input, context)
        const value = yield* Schema.decodeUnknownEffect(output)(raw).pipe(
          Effect.mapError(() => new Tool.Error({ message: `Action "${definition.name}" returned invalid outputs` })),
        )
        return ActionOutput.result(ActionOutput.project(definition.outputs, value))
      }),
  }
})

const fields = Effect.fnUntraced(function* (catalog: Catalog, kind: "inputs" | "outputs", entries: Definition["inputs"]) {
  const resolved = yield* Effect.forEach(Object.entries(entries), ([name, field]) => {
    const type = Object.hasOwn(catalog.types, field.type) ? catalog.types[field.type] : undefined
    return !Schema.isSchema(type)
      ? Effect.fail(new Tool.Error({ message: `Unknown type "${field.type}" at ${kind}.${name}` }))
      : Effect.succeed([name, kind === "outputs" || field.is_required === true ? type : Schema.optionalKey(type)] as const)
  })
  return Schema.Struct(Object.fromEntries(resolved))
})
