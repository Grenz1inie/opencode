export * as ActionTool from "./action.js"

import { ActionOutput } from "@opencode/flight-action"
import type { Catalog, Definition } from "@opencode/plugin/action"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Schema, Scope } from "effect"
import { ConfigEntryObserver } from "../config/plugin/entry-observer.js"
import type { Form } from "../form.js"
import { Permission } from "../permission.js"
import { ActionInput } from "./action-input.js"
import { normalizedName } from "./runtime.js"

type Host = Pick<Context, "tool" | "permission" | "event"> & {
  readonly enabled: Effect.Effect<boolean>
  readonly forms: Form.Interface
}

export const register = Effect.fn("ActionTool.register")(function* (catalog: Catalog, host: Host) {
  const tools = yield* Effect.forEach(catalog.actions, (definition) =>
    compile(catalog, definition, host).pipe(
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

const compile = Effect.fnUntraced(function* (catalog: Catalog, definition: Definition, host: Host) {
  const target = Object.hasOwn(catalog.targets, definition.target) ? catalog.targets[definition.target] : undefined
  if (typeof target !== "function") return yield* new Tool.Error({ message: `Unknown target "${definition.target}" at target` })

  const input = yield* ActionInput.compile(catalog, definition, host.forms)
  const output = yield* outputFields(catalog, definition.outputs)
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
    description: input.collects
      ? definition.description + "\nPass only known values. Omit unknown inputs so OpenCode can collect eligible required values in a form."
      : definition.description,
    options: { codemode: false },
    input: input.schema,
    output: modelOutput,
    execute: (rawInput: Schema.JsonObject, context: Tool.Context) =>
      Effect.gen(function* () {
        const values = yield* input.prepare(rawInput, context)
        yield* host.permission.assert({ action, resources: ["*"], save: ["*"], ...Permission.invocation(context) })
        const raw = yield* target(values, context)
        const value = yield* Schema.decodeUnknownEffect(output)(raw).pipe(
          Effect.mapError(() => new Tool.Error({ message: `Action "${definition.name}" returned invalid outputs` })),
        )
        const projections = ActionOutput.project(definition.outputs, value)
        return { ...ActionOutput.result(projections, view), output: projections.model }
      }),
  }
})

const outputFields = Effect.fnUntraced(function* (catalog: Catalog, entries: Definition["outputs"]) {
  const resolved = yield* Effect.forEach(Object.entries(entries), ([name, field]) => {
    const type = ActionInput.typeFor(catalog, field.type)
    return type
      ? Effect.succeed([name, type] as const)
      : Effect.fail(new Tool.Error({ message: `Unknown type "${field.type}" at outputs.${name}` }))
  })
  return Schema.Struct(Object.fromEntries(resolved))
})
