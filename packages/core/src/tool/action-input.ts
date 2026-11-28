export * as ActionInput from "./action-input.js"

import { LightningEditor } from "@opencode/flight-action"
import type { Catalog, Definition, InputField } from "@opencode/plugin/action"
import { Tool } from "@opencode/schema/tool"
import { isRecord } from "@opencode/util/record"
import { Effect, Result, Schema, SchemaIssue } from "effect"
import { Form } from "../form.js"
import { inputJsonSchema } from "./runtime.js"

const channel = "lightningDesktopGenAi"
const standardTypes = {
  lightning__textType: LightningEditor.NonblankText,
  lightning__dateType: LightningEditor.CalendarDate,
}
const standardType = (name: string) =>
  Object.hasOwn(standardTypes, name) ? (name as keyof typeof standardTypes) : undefined

const own = <T>(value: Readonly<Record<string, T>> | undefined, key: string) =>
  value && Object.hasOwn(value, key) ? value[key] : undefined

export function typeFor(catalog: Catalog, name: string) {
  const type = own(catalog.types, name)
  if (Schema.isSchema(type)) return type
  const standard = standardType(name)
  return standard && standardTypes[standard]
}

type Control = {
  readonly path: readonly string[]
  readonly type: keyof typeof standardTypes
  readonly field: LightningEditor.Field
}
type Collector = {
  readonly controls: readonly Control[]
  readonly editor?: { readonly channel: string; readonly definition: string }
  readonly title?: string
}

function collector(catalog: Catalog, name: string, input: InputField): Collector | undefined {
  if (!input.is_required || !input.is_user_input) return
  const standard = standardType(input.type)
  if (standard)
    return {
      controls: [
        {
          path: [name],
          type: standard,
          field: LightningEditor.standardField(name, standard, input.title ?? name, true),
        },
      ],
    }
  const registered = own(own(catalog.editors, input.type), channel)
  if (!registered) return
  return {
    editor: { channel, definition: registered.definition },
    title: registered.title,
    controls: registered.fields.map(({ path, type, title, required }) => ({
      path: [name, ...path],
      type,
      field: LightningEditor.standardField([name, ...path].join("."), type, title, required === true),
    })),
  }
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()
const draftSchema = Schema.toStandardSchemaV1(Schema.JsonObject)["~standard"]
const paths = (issue: SchemaIssue.Issue) =>
  formatIssues(issue).issues.map(({ path }) =>
    (path ?? []).map((segment) => (typeof segment === "object" ? segment.key : segment)),
  )
const diagnostic = (path: readonly unknown[]) =>
  new Tool.Error({ message: `Invalid Action input: ${path.join(".") || "input"}` })

export const compile = Effect.fnUntraced(function* (catalog: Catalog, definition: Definition, forms: Form.Interface) {
  const entries = yield* Effect.forEach(Object.entries(definition.inputs), ([name, input]) => {
    const codec = typeFor(catalog, input.type)
    if (!codec) return Effect.fail(new Tool.Error({ message: `Unknown type "${input.type}" at inputs.${name}` }))
    const collection = collector(catalog, name, input)
    if (input.is_required && input.is_user_input && !collection)
      return Effect.fail(
        new Tool.Error({ message: `No input Editor for "${input.type}" on "${channel}" at inputs.${name}` }),
      )
    return Effect.succeed({ name, codec, required: input.is_required === true, collection })
  })
  const complete = Schema.Struct(
    Object.fromEntries(
      entries.map(({ name, codec, required }) => [name, required ? codec : Schema.optionalKey(codec)]),
    ),
  )
  if (!entries.some((entry) => entry.collection)) {
    return { schema: complete, collects: false, prepare: (input: Schema.JsonObject) => Effect.succeed(input) }
  }

  const advertised = Schema.Struct(
    Object.fromEntries(
      entries.map(({ name, codec, required, collection }) => [
        name,
        required && !collection ? codec : Schema.optionalKey(codec),
      ]),
    ),
  )
  // The provider sees typed arguments. The tool admits drafts and checks the complete codec before target execution.
  const json = inputJsonSchema(advertised)
  for (const { collection } of entries) {
    for (const control of collection?.controls ?? []) makeOmittable(json, control.path)
  }
  const schema = { "~standard": { ...draftSchema, jsonSchema: { input: () => json, output: () => json } } }
  const decode = (input: Schema.JsonObject) =>
    Schema.decodeUnknownEffect(complete)(input).pipe(
      Effect.mapError((error) => diagnostic(paths(error.issue)[0] ?? [])),
    )

  const prepare = Effect.fnUntraced(function* (draft: Schema.JsonObject, context: Tool.Context) {
    const known: Array<[string, Schema.Json]> = []
    const controls: Control[] = []
    const editors: Array<NonNullable<Collector["editor"]>> = []
    let editorTitle: string | undefined
    for (const { name, codec, required, collection } of entries) {
      const value = own(draft, name)
      const checked = yield* Schema.decodeUnknownEffect(codec)(value).pipe(Effect.result)
      if (value !== undefined && Result.isSuccess(checked)) {
        known.push([name, value])
        continue
      }
      if (!required) continue
      if (!collection) {
        const path = Result.isFailure(checked) && value !== undefined ? paths(checked.failure.issue)[0] : undefined
        return yield* diagnostic([name, ...(path ?? [])])
      }
      if (collection.editor) {
        const partial = yield* editableDraft(name, value, collection.controls, codec)
        known.push([name, partial])
        editors.push(collection.editor)
        editorTitle = collection.title
      }
      controls.push(...collection.controls)
    }

    const values = Object.fromEntries(known)
    const [first, ...rest] = controls.map(({ path, type, field }) => {
      const value = read(values, path)
      return Schema.is(standardTypes[type])(value) ? { ...field, default: value } : field
    })
    if (!first) return yield* decode(values)

    const submitted = (answer: Form.Answer) =>
      decode(controls.reduce((input, control) => write(input, control.path, own(answer, control.field.key)), values))
    const state = yield* forms
      .ask({
        sessionID: context.sessionID,
        title: editors.length === 1 && editorTitle ? editorTitle : definition.name,
        fields: [first, ...rest],
        metadata: {
          kind: "action",
          action: definition.name,
          ...(editors.length > 0 && { editor: editors.length === 1 ? editors[0] : editors }),
          tool: { messageID: context.messageID, id: context.id },
        },
        validate: (answer) =>
          submitted(answer).pipe(Effect.match({ onSuccess: () => undefined, onFailure: (error) => error.message })),
      })
      .pipe(Effect.mapError((error) => new Tool.Error({ message: error.message })))
    if (state.status === "cancelled") return yield* Effect.die(new Form.CancelledError({ action: definition.name }))
    return yield* submitted(state.answer)
  })
  return { schema, collects: true, prepare }
})

const editableDraft = Effect.fnUntraced(function* (
  name: string,
  value: Schema.Json | undefined,
  controls: readonly Control[],
  codec: Schema.Codec<Schema.Json, Schema.Json>,
) {
  let draft: Schema.JsonObject = record(value)
  for (const { path, field } of controls) {
    const parent = path.slice(1, -1)
    if (field.required && parent.length > 0) draft = write(draft, parent, record(read(draft, parent)))
  }
  const checked = yield* Schema.decodeUnknownEffect(codec)(draft, { errors: "all" }).pipe(Effect.result)
  if (Result.isFailure(checked)) {
    const blocked = paths(checked.failure.issue).find((path) =>
      controls.every((control) => !path.every((segment, index) => segment === control.path[index + 1])),
    )
    if (blocked) return yield* diagnostic([name, ...blocked])
  }
  return draft
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
