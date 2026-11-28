export * as ActionTool from "./action.js"

import { ActionOutput } from "@opencode/flight-action"
import type { Catalog, Definition } from "@opencode/plugin/action"
import type { Context } from "@opencode/plugin/effect/plugin"
import { ActionConfirmation } from "@opencode/schema/form"
import { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Result, Schema, SchemaAST, SchemaIssue, Scope } from "effect"
import { ConfigEntryObserver } from "../config/plugin/entry-observer.js"
import { Form } from "../form.js"
import { Permission } from "../permission.js"
import { ActionInput } from "./action-input.js"
import { normalizedName } from "./runtime.js"

type Host = Pick<Context, "tool" | "permission" | "event"> & {
  readonly enabled: Effect.Effect<boolean>
  readonly forms: Form.Interface
  readonly assertNotDenied: Permission.Interface["assertNotDenied"]
  readonly readSession: Context["session"]["get"]
}

const Confirmation = Schema.Struct({ title: Schema.NonEmptyString, message: Schema.NonEmptyString })
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()
const decodeView = Schema.decodeUnknownResult(ActionOutput.View)

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
  const available = definition.available
  if (available !== undefined && typeof available !== "function")
    return yield* new Tool.Error({ message: `Invalid availability condition for "${definition.name}" at available` })
  const confirmation = definition.confirmation === undefined
    ? undefined
    : yield* Schema.decodeUnknownEffect(Confirmation)(definition.confirmation).pipe(
        Effect.mapError((error) => new Tool.Error({ message: `Invalid confirmation for "${definition.name}": ${error.message}` })),
      )

  const input = yield* Effect.fromResult(ActionInput.compile(catalog, definition, host.forms))
  const output = yield* outputFields(catalog, definition.outputs)
  const modelOutput = Schema.Struct(
    Object.fromEntries(Object.entries(output.fields).flatMap(([name, type]) =>
      definition.outputs[name]?.filter_from_agent === true ? [] : [[name, Schema.toType(type)] as const],
    )),
  )
  const presentation = resolveView(catalog, definition)
  const action = normalizedName(definition)
  const targetFailure = () => new Tool.Error({
    message: `Action "${definition.name}" failed at target`,
    metadata: { actionDiagnostic: { stage: "actionResult", path: "target" } },
  })

  const requireAvailable = (context: Tool.RequestContext) =>
    available
      ? available(context).pipe(Effect.flatMap((allowed) =>
          allowed ? Effect.void : new Tool.Error({ message: `Action "${definition.name}" is not currently available` }),
        ))
      : Effect.void
  const currentRequest = (request: Tool.RequestContext) => host.readSession({ sessionID: request.sessionID }).pipe(
    Effect.map((session) => ({ ...request, sessionMetadata: session.metadata })),
    Effect.mapError((error) => new Tool.Error({ message: `Cannot load the session for Action "${definition.name}"`, error })),
  )

  return {
    name: definition.name,
    ...(available && { available }),
    description: input.collects
      ? definition.description + "\nPass only known values. Omit unknown inputs so OpenCode can collect eligible required values in a form."
      : definition.description,
    options: { codemode: false },
    input: input.schema,
    output: modelOutput,
    execute: (rawInput: Schema.JsonObject, context: Tool.Context) =>
      Effect.gen(function* () {
        const request = { sessionID: context.sessionID, agent: context.agent }
        if (available) yield* currentRequest(request).pipe(Effect.flatMap(requireAvailable))
        const values = yield* input.prepare(rawInput, context)
        if (available && input.collects) yield* currentRequest(request).pipe(Effect.flatMap(requireAvailable))
        if (confirmation) {
          const state = yield* host.forms.ask({
            sessionID: context.sessionID,
            title: confirmation.title,
            metadata: {
              kind: ActionConfirmation.kind,
              operation: ActionConfirmation.operation,
              message: confirmation.message,
              action: definition.name,
              tool: { messageID: context.messageID, id: context.id },
            },
            fields: [{ key: ActionConfirmation.field, type: "boolean", title: confirmation.title, required: true }],
          }).pipe(Effect.mapError((error) => new Tool.Error({ message: error.message })))
          if (state.status !== "answered" || state.answer[ActionConfirmation.field] !== true)
            return yield* Effect.die(new Form.CancelledError({ action: `confirmation for "${definition.name}"` }))
        }
        if (available && confirmation) yield* currentRequest(request).pipe(Effect.flatMap(requireAvailable))
        const permission = { action, resources: ["*"], save: ["*"], ...Permission.invocation(context) }
        yield* host.permission.assert(permission)
        const current = available || input.bind ? yield* currentRequest(request) : request
        yield* requireAvailable(current)
        const bound = input.bind ? yield* input.bind(current) : undefined
        // A decision made in an open permission prompt cannot override a subsequent deny rule.
        yield* host.assertNotDenied(permission).pipe(
          Effect.mapError((error) => new Tool.Error({ message: error.message, error })),
        )

        const targetContext: Tool.Context = {
          ...context,
          // Progress can survive in failed tool parts. Only the host publishes Action result fields.
          progress: ({ actionOutput: _output, actionDiagnostic: _diagnostic, output: _text, ...metadata }) =>
            context.progress({ ...metadata, actionOutput: { outputs: {} } }),
        }
        const raw = yield* Effect.suspend(() => target(bound ? { ...values, ...bound } : values, targetContext)).pipe(
          Effect.mapError(targetFailure),
          Effect.catchDefect((cause) =>
            Effect.die(
              cause instanceof Form.CancelledError || cause instanceof Permission.DeclinedError ? cause : targetFailure(),
            ),
          ),
        )
        const value = yield* Schema.decodeUnknownEffect(output)(raw).pipe(
          Effect.mapError(({ issue }) => {
            const path = outputIssuePath(output.ast, firstIssuePath(issue))
            return new Tool.Error({
              message: `Action "${definition.name}" returned invalid outputs at ${path}`,
              metadata: { actionDiagnostic: { stage: "actionSchema", path } },
            })
          }),
        )
        const projections = ActionOutput.project(definition.outputs, value)
        return { ...ActionOutput.result(projections, presentation.view, presentation.diagnostic), output: projections.model }
      }),
  }
})

function firstIssuePath(issue: SchemaIssue.Issue) {
  return (formatIssues(issue).issues[0]?.path ?? []).map((segment) =>
    typeof segment === "object" ? segment.key : segment,
  )
}

function declaredMember(ast: SchemaAST.AST, key: PropertyKey): SchemaAST.AST | undefined {
  if (SchemaAST.isObjects(ast)) return ast.propertySignatures.find((field) => field.name === key)?.type
  if (SchemaAST.isArrays(ast) && typeof key === "number") return ast.elements[key] ?? ast.rest[0]
  if (SchemaAST.isSuspend(ast)) return declaredMember(ast.thunk(), key)
  if (SchemaAST.isUnion(ast)) {
    for (const member of ast.types) {
      const field = declaredMember(member, key)
      if (field) return field
    }
  }
}

function outputIssuePath(ast: SchemaAST.AST, segments: readonly PropertyKey[]) {
  let path = "outputs"
  for (const segment of segments) {
    const member = declaredMember(ast, segment)
    // Keys from a returned record can themselves be output data.
    if (!member) break
    path += typeof segment === "number" ? `[${segment}]` : "." + String(segment)
    ast = member
  }
  return path
}

function resolveView(catalog: Catalog, definition: Definition): {
  view?: ActionOutput.View
  diagnostic?: ActionOutput.Diagnostic
} {
  let widget = definition.widget
  if (definition.renderer !== undefined) {
    const id = definition.renderer
    const path = `renderers.${id}`
    const renderer = catalog.renderers && Object.hasOwn(catalog.renderers, id) ? catalog.renderers[id] : undefined
    if (!renderer) return { diagnostic: { stage: "renderer", path } }
    if (!Object.values(definition.outputs).some((output) => output.type === renderer.type && output.is_displayable === true))
      return { diagnostic: { stage: "renderer", path: path + ".type" } }
    if (typeof renderer.widget !== "string" || !renderer.widget)
      return { diagnostic: { stage: "renderer", path: path + ".widget" } }
    widget = renderer.widget
  }
  if (widget === undefined) return {}
  const resource = catalog.widgets && Object.hasOwn(catalog.widgets, widget) ? catalog.widgets[widget] : undefined
  const path = `widgets.${widget}`
  if (!resource) return { diagnostic: { stage: "widget", path } }
  const decoded = decodeView({ ...resource, id: widget })
  return Result.isSuccess(decoded)
    ? { view: decoded.success }
    : { diagnostic: { stage: "widget", path: [path, ...firstIssuePath(decoded.failure.issue)].map(String).join(".") } }
}

const outputFields = Effect.fnUntraced(function* (catalog: Catalog, entries: Definition["outputs"]) {
  const resolved = yield* Effect.forEach(Object.entries(entries), ([name, field]) => {
    const type = Object.hasOwn(catalog.types, field.type) ? catalog.types[field.type] : undefined
    return Schema.isSchema(type)
      ? Effect.succeed([name, type] as const)
      : Effect.fail(new Tool.Error({ message: `Unknown type "${field.type}" at outputs.${name}.type` }))
  })
  return Schema.Struct(Object.fromEntries(resolved))
})
