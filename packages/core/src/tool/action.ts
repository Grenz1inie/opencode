export * as ActionTool from "./action.js"

import { ActionOutput } from "@opencode/flight-action"
import type { Catalog, Definition } from "@opencode/plugin/action"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Schema, Scope } from "effect"
import { ConfigEntryObserver } from "../config/plugin/entry-observer.js"
import { Permission } from "../permission.js"
import { normalizedName } from "./runtime.js"

type Host = Pick<Context, "tool" | "permission" | "event"> & {
  readonly enabled: Effect.Effect<boolean>
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
  const owner = yield* Scope.Scope
  const scope = yield* Scope.fork(owner)
  const enabled = yield* ConfigEntryObserver.observeValue(host.enabled, host.event, host.tool.reload()).pipe(
    Scope.provide(scope),
  )
  yield* host.tool.transform((editor) => {
    if (!enabled.value) return
    tools.forEach((tool) => {
      if (tool) editor.add(tool)
    })
  }).pipe(Scope.provide(scope))

  return { dispose: Scope.close(scope, Exit.void) }
})

const compile = Effect.fnUntraced(function* (catalog: Catalog, definition: Definition, permission: Context["permission"]) {
  const target = Object.hasOwn(catalog.targets, definition.target) ? catalog.targets[definition.target] : undefined
  if (typeof target !== "function") return yield* new Tool.Error({ message: `Unknown target "${definition.target}" at target` })

  const input = yield* fields(catalog, "inputs", definition.inputs)
  const output = yield* fields(catalog, "outputs", definition.outputs)
  const modelOutput = Schema.Struct(
    Object.fromEntries(Object.entries(output.fields).flatMap(([name, type]) =>
      definition.outputs[name]?.filter_from_agent === true ? [] : [[name, Schema.toType(type)] as const],
    )),
  )
  const widget = definition.widget
  const widgets = catalog.widgets ?? {}
  const view = widget === undefined
    ? undefined
    : yield* Schema.decodeUnknownEffect(ActionOutput.View)({
        ...(Object.hasOwn(widgets, widget) ? widgets[widget] : undefined),
        id: widget,
      }).pipe(Effect.mapError((error) => new Tool.Error({ message: `Invalid widget "${widget}" at widget: ${error.message}` })))
  const action = normalizedName(definition)

  return {
    name: definition.name,
    description: definition.description,
    options: { codemode: false },
    input,
    output: modelOutput,
    execute: (input: Schema.JsonObject, context: Tool.Context) =>
      Effect.gen(function* () {
        yield* permission.assert({ action, resources: ["*"], save: ["*"], ...Permission.invocation(context) })
        const raw = yield* target(input, context)
        const value = yield* Schema.decodeUnknownEffect(output)(raw).pipe(
          Effect.mapError(() => new Tool.Error({ message: `Action "${definition.name}" returned invalid outputs` })),
        )
        const projections = ActionOutput.project(definition.outputs, value)
        return { ...ActionOutput.result(projections, view), output: projections.model }
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
