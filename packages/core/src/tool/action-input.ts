export * as ActionInput from "./action-input.js"

import { LightningEditor } from "@opencode/flight-action"
import type { ActionContext, Catalog, Definition, InputField, StandardInputType } from "@opencode/plugin/action"
import { Tool } from "@opencode/schema/tool"
import { isRecord } from "@opencode/util/record"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { Deferred, Effect, Result, Schema, SchemaIssue } from "effect"
import { Form } from "../form.js"
import { inputJsonSchema } from "./runtime.js"

const channel = "lightningDesktopGenAi"
const standardTypes = {
  lightning__textType: LightningEditor.NonblankText,
  lightning__dateType: LightningEditor.CalendarDate,
  lightning__numberType: Schema.Finite,
  lightning__integerType: Schema.Int,
  lightning__booleanType: Schema.Boolean,
} satisfies Record<StandardInputType, Schema.Codec<Schema.Json, Schema.Json>>

const standardType = (name: string): name is StandardInputType => Object.hasOwn(standardTypes, name)
const own = <T>(value: Readonly<Record<string, T>> | undefined, key: string) =>
  value && Object.hasOwn(value, key) ? value[key] : undefined

type ControlField = Extract<Form.Field, { type: "string" | "boolean" | "number" | "integer" }>
type Control = { readonly path: readonly string[]; readonly field: ControlField }
type Collector = {
  readonly controls: readonly Control[]
  readonly editor?: { readonly channel: string; readonly definition: string; readonly title: string }
}
type InputCodec = Schema.Codec<Schema.Json, Schema.Json>
type Entry = {
  readonly name: string
  readonly codec: InputCodec
  readonly required: boolean
  readonly collection?: Collector
}
type Compiled = {
  readonly schema:
    | Schema.Codec<Schema.JsonObject, Schema.JsonObject>
    | StandardSchemaV1<Schema.JsonObject, Schema.JsonObject>
  readonly collects: boolean
  readonly prepare: (input: Schema.JsonObject, context: Tool.Context) => Effect.Effect<Schema.JsonObject, Tool.Error>
  readonly bind?: (context: ActionContext) => Effect.Effect<Schema.JsonObject, Tool.Error>
}

const parseEditor = Schema.decodeUnknownResult(
  Schema.Struct({
    definition: Schema.NonEmptyString,
    title: Schema.NonEmptyString,
    fields: Schema.NonEmptyArray(
      Schema.Struct({
        path: Schema.NonEmptyArray(Schema.String.check(Schema.isPattern(/^[^.]+$/))),
        type: Schema.Literals(Object.keys(standardTypes).filter(standardType)),
        title: Schema.NonEmptyString,
        required: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  }),
)

function collect(catalog: Catalog, name: string, input: InputField): Result.Result<Collector, Tool.Error> {
  if (standardType(input.type))
    return Result.succeed({
      controls: [{ path: [name], field: controlField(name, input.type, input.title ?? name, true) }],
    })
  const registered = own(own(catalog.editors, input.type), channel)
  if (registered === undefined)
    return Result.fail(
      new Tool.Error({ message: `No input Editor for "${input.type}" on "${channel}" at inputs.${name}` }),
    )

  const parsed = parseEditor(registered)
  if (Result.isFailure(parsed))
    return Result.fail(
      new Tool.Error({ message: `Invalid Editor for "${input.type}" at inputs.${name}: ${parsed.failure.message}` }),
    )
  const { definition, title, fields } = parsed.success
  return Result.succeed({
    editor: { channel, definition, title },
    controls: fields.map(({ path, type, title, required }) => ({
      path: [name, ...path],
      field: controlField([name, ...path].join("."), type, title, required === true),
    })),
  })
}

function controlField(key: string, type: StandardInputType, title: string, required: boolean): ControlField {
  if (type === "lightning__booleanType") return { key, type: "boolean", title, required }
  if (type === "lightning__numberType") return { key, type: "number", title, required }
  if (type === "lightning__integerType") return { key, type: "integer", title, required }
  return LightningEditor.standardField(key, type, title, required)
}

function prefill(field: ControlField, value: Schema.Json | undefined): ControlField {
  if (field.type === "boolean") return typeof value === "boolean" ? { ...field, default: value } : field
  if (field.type === "number" || field.type === "integer") {
    const valid = field.type === "number" ? Number.isFinite(value) : Number.isInteger(value)
    return typeof value === "number" && valid ? { ...field, default: value } : field
  }
  if (typeof value !== "string") return field
  if (field.format === "date" && !Schema.is(LightningEditor.CalendarDate)(value)) return field
  if (field.pattern && !Schema.is(LightningEditor.NonblankText)(value)) return field
  return { ...field, default: value }
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()
const draftSchema = Schema.toStandardSchemaV1(Schema.JsonObject)["~standard"]
const paths = (issue: SchemaIssue.Issue) =>
  formatIssues(issue).issues.map(({ path }) =>
    (path ?? []).map((segment) => (typeof segment === "object" ? segment.key : segment)),
  )
const diagnostic = (path: readonly PropertyKey[]) =>
  new Tool.Error({ message: `Invalid Action input: ${path.map(String).join(".") || "input"}` })

export function compile(
  catalog: Catalog,
  definition: Definition,
  forms: Form.Interface,
): Result.Result<Compiled, Tool.Error> {
  const entries: Entry[] = []
  const bindings: Array<Entry & { readonly read: NonNullable<InputField["bind"]> }> = []
  for (const [name, input] of Object.entries(definition.inputs)) {
    const declared = own(catalog.types, input.type)
    const codec = Schema.isSchema(declared)
      ? declared
      : standardType(input.type)
        ? standardTypes[input.type]
        : undefined
    if (!codec) return Result.fail(new Tool.Error({ message: `Unknown type "${input.type}" at inputs.${name}` }))
    const required = input.is_required === true
    if (input.bind !== undefined) {
      if (typeof input.bind !== "function")
        return Result.fail(new Tool.Error({ message: `Invalid binding at inputs.${name}.bind` }))
      bindings.push({ name, codec, required, read: input.bind })
      continue
    }
    if (!required || input.is_user_input !== true) {
      entries.push({ name, codec, required })
      continue
    }
    const collection = collect(catalog, name, input)
    if (Result.isFailure(collection)) return Result.fail(collection.failure)
    entries.push({ name, codec, required, collection: collection.success })
  }
  const controls = entries.flatMap(({ collection }) => collection?.controls ?? [])
  const bind = bindings.length
    ? Effect.fnUntraced(function* (context: ActionContext) {
        const values = yield* Effect.forEach(bindings, ({ name, codec, required, read }) =>
          Effect.gen(function* () {
            const value = yield* read(context)
            if (value === undefined) {
              if (required) return yield* diagnostic([name])
              return
            }
            const decoded = yield* Schema.decodeUnknownEffect(codec)(value).pipe(
              Effect.mapError((error) => diagnostic([name, ...(paths(error.issue)[0] ?? [])])),
            )
            return [name, decoded] as const
          }),
        )
        return Object.fromEntries(values.filter((entry) => entry !== undefined))
      })
    : undefined
  const advertised = Schema.Struct(
    Object.fromEntries(
      entries.map(({ name, codec, required, collection }) => [
        name,
        required && !collection ? codec : Schema.optionalKey(codec),
      ]),
    ),
  )
  if (!controls.length) {
    const supplied = new Set(entries.map(({ name }) => name))
    return Result.succeed({
      schema: advertised,
      collects: false,
      prepare: (input: Schema.JsonObject) =>
        Effect.succeed(bind ? Object.fromEntries(Object.entries(input).filter(([name]) => supplied.has(name))) : input),
      ...(bind && { bind }),
    })
  }
  const invalid = Form.validateFields(controls.map(({ field }) => field))
  if (invalid) return Result.fail(new Tool.Error({ message: invalid }))

  // The provider sees typed arguments. The executor admits drafts for fields the user can repair.
  const json = inputJsonSchema(advertised)
  for (const { path } of controls) makeOmittable(json, path)
  const schema = { "~standard": { ...draftSchema, jsonSchema: { input: () => json, output: () => json } } }
  const prepare = Effect.fnUntraced(function* (draft: Schema.JsonObject, context: Tool.Context) {
    const known: Array<[string, Schema.Json]> = []
    const pending: Array<{ name: string; codec: InputCodec; collection: Collector; draft?: Schema.JsonObject }> = []
    for (const { name, codec, required, collection } of entries) {
      const value = own(draft, name)
      if (value === undefined && !required) continue
      const decoded =
        value === undefined ? undefined : yield* Schema.decodeUnknownEffect(codec)(value).pipe(Effect.result)
      if (decoded && Result.isSuccess(decoded)) {
        known.push([name, decoded.success])
        continue
      }
      if (!collection) {
        const path = decoded && Result.isFailure(decoded) ? paths(decoded.failure.issue)[0] : undefined
        return yield* diagnostic([name, ...(path ?? [])])
      }
      const partial = collection.editor ? yield* editableDraft(name, value, collection.controls, codec) : undefined
      pending.push({ name, codec, collection, ...(partial && { draft: partial }) })
    }
    const knownValues = Object.fromEntries(known)
    if (!pending.length) return knownValues

    const drafts: Schema.JsonObject = Object.fromEntries(
      pending.flatMap(({ name, draft }) => (draft ? [[name, draft]] : [])),
    )
    const edits = pending.flatMap(({ collection }) => collection.controls)
    const [first, ...rest] = edits.map(({ path, field }) => prefill(field, read(drafts, path)))
    if (!first) return knownValues

    const editors = pending.flatMap(({ collection }) => (collection.editor ? [collection.editor] : []))
    const decodeEdits = Schema.decodeUnknownEffect(
      Schema.Struct(Object.fromEntries(pending.map(({ name, codec }) => [name, codec]))),
    )
    const accepted = yield* Deferred.make<Schema.JsonObject>()
    const state = yield* forms
      .ask({
        sessionID: context.sessionID,
        title: editors.length === 1 ? (editors[0]?.title ?? definition.name) : definition.name,
        fields: [first, ...rest],
        metadata: {
          kind: "action",
          action: definition.name,
          ...(editors.length > 0 && {
            editor:
              editors.length === 1
                ? { channel: editors[0]?.channel, definition: editors[0]?.definition }
                : editors.map(({ channel, definition }) => ({ channel, definition })),
          }),
          tool: { messageID: context.messageID, id: context.id },
        },
        validate: (answer) =>
          decodeEdits(
            edits.reduce((input, { path, field }) => write(input, path, own(answer, field.key)), drafts),
          ).pipe(
            Effect.mapError((error) => diagnostic(paths(error.issue)[0] ?? []).message),
            Effect.map((values) => Deferred.succeed(accepted, { ...knownValues, ...values }).pipe(Effect.asVoid)),
          ),
      })
      .pipe(Effect.mapError((error) => new Tool.Error({ message: error.message })))
    if (state.status === "cancelled") return yield* Effect.die(new Form.CancelledError({ action: definition.name }))
    return yield* Deferred.await(accepted)
  })
  return Result.succeed({ schema, collects: true, prepare, ...(bind && { bind }) })
}

const editableDraft = Effect.fnUntraced(function* (
  name: string,
  value: Schema.Json | undefined,
  controls: readonly Control[],
  codec: InputCodec,
) {
  let draft = record(value)
  const decode = Schema.decodeUnknownEffect(codec)
  const covered = (path: readonly PropertyKey[]) =>
    controls.some((control) => path.every((segment, index) => segment === control.path[index + 1]))

  while (true) {
    const checked = yield* decode(draft, { errors: "all" }).pipe(Effect.result)
    if (Result.isSuccess(checked)) return draft
    const issues = paths(checked.failure.issue)
    const blocked = issues.find((path) => !covered(path))
    if (blocked) return yield* diagnostic([name, ...blocked])

    // Inspect required fields inside a missing or malformed object before showing its Editor.
    const parent = issues.find(
      (path): path is string[] =>
        path.length > 0 &&
        path.every((segment) => typeof segment === "string") &&
        controls.some(
          (control) =>
            path.length + 1 < control.path.length &&
            path.every((segment, index) => segment === control.path[index + 1]),
        ) &&
        !isJsonObject(read(draft, path)),
    )
    if (!parent) return draft
    draft = write(draft, parent, {})
  }
})

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject => isRecord(value)
const record = (value: Schema.Json | undefined): Schema.JsonObject => (isJsonObject(value) ? value : {})

function read(value: Schema.Json | undefined, path: readonly string[]) {
  return path.reduce<Schema.Json | undefined>((current, key) => own(record(current), key), value)
}

function write(
  input: Schema.JsonObject,
  [key, ...rest]: readonly string[],
  value: Schema.Json | undefined,
): Schema.JsonObject {
  if (key === undefined) return input
  if (value === undefined && !Object.hasOwn(input, key)) return input
  const next = rest.length === 0 ? value : write(record(own(input, key)), rest, value)
  return next === undefined
    ? Object.fromEntries(Object.entries(input).filter(([name]) => name !== key))
    : { ...input, [key]: next }
}

function makeOmittable(schema: unknown, path: readonly string[]) {
  if (!isRecord(schema)) return
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const options = schema[keyword]
    if (Array.isArray(options)) options.forEach((option) => makeOmittable(option, path))
  }
  const [key, ...rest] = path
  if (key === undefined || !isRecord(schema.properties) || !Object.hasOwn(schema.properties, key)) return
  if (Array.isArray(schema.required)) schema.required = schema.required.filter((name) => name !== key)
  if (rest.length > 0) makeOmittable(schema.properties[key], rest)
}
