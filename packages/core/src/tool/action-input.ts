export * as ActionInput from "./action-input.js"

import { LightningEditor } from "@opencode/flight-action"
import type { Catalog, Definition } from "@opencode/plugin/action"
import { Tool } from "@opencode/schema/tool"
import { Effect, Option, Schema, SchemaIssue } from "effect"
import { Form } from "../form.js"

const standardTypes = {
  lightning__textType: LightningEditor.NonblankText,
  lightning__dateType: LightningEditor.CalendarDate,
}

const standardType = (name: string) =>
  Object.hasOwn(standardTypes, name) ? (name as keyof typeof standardTypes) : undefined

export function typeFor(catalog: Catalog, name: string) {
  const type = Object.hasOwn(catalog.types, name) ? catalog.types[name] : undefined
  if (Schema.isSchema(type)) return type
  const standard = standardType(name)
  return standard && standardTypes[standard]
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()
const validateDraft = Schema.toStandardSchemaV1(Schema.JsonObject)["~standard"].validate

export const compile = Effect.fnUntraced(function* (catalog: Catalog, definition: Definition, forms: Form.Interface) {
  const entries = yield* Effect.forEach(Object.entries(definition.inputs), ([name, input]) => {
    const codec = typeFor(catalog, input.type)
    if (!codec) return Effect.fail(new Tool.Error({ message: `Unknown type "${input.type}" at inputs.${name}` }))
    const required = input.is_required === true
    const standard = standardType(input.type)
    const collect = required && input.is_user_input === true
    if (collect && !standard)
      return Effect.fail(new Tool.Error({ message: `No input Editor for "${input.type}" at inputs.${name}` }))
    const field =
      collect && standard ? LightningEditor.standardField(name, standard, input.title ?? name, true) : undefined
    return Effect.succeed({ name, codec, required, field })
  })
  const complete = Schema.Struct(
    Object.fromEntries(
      entries.map(({ name, codec, required }) => [name, required ? codec : Schema.optionalKey(codec)]),
    ),
  )
  if (!entries.some((entry) => entry.field)) {
    return { schema: complete, collects: false, prepare: (input: Schema.JsonObject) => Effect.succeed(input) }
  }

  const advertised = Schema.Struct(
    Object.fromEntries(
      entries.map(({ name, codec, required, field }) => [name, required && !field ? codec : Schema.optionalKey(codec)]),
    ),
  )
  // Keep types in the model schema while admitting invalid drafts for repair in the form.
  const schema = {
    "~standard": { ...Schema.toStandardJSONSchemaV1(advertised)["~standard"], validate: validateDraft },
  }
  const decode = (input: Schema.JsonObject) =>
    Schema.decodeUnknownEffect(complete)(input).pipe(
      Effect.mapError((error) => {
        const path = formatIssues(error.issue).issues[0]?.path?.join(".") || "input"
        return new Tool.Error({ message: `Invalid Action input: ${path}` })
      }),
    )
  const prepare = Effect.fnUntraced(function* (draft: Schema.JsonObject, context: Tool.Context) {
    const known: Array<[string, Schema.Json]> = []
    const fields: Form.Field[] = []
    for (const { name, codec, required, field } of entries) {
      const value = Object.hasOwn(draft, name) ? draft[name] : undefined
      if (value !== undefined && Option.isSome(yield* Schema.decodeUnknownEffect(codec)(value).pipe(Effect.option))) {
        known.push([name, value])
        continue
      }
      if (!required) continue
      if (!field) return yield* new Tool.Error({ message: `Missing or invalid required Action input: ${name}` })
      fields.push(field)
    }

    const values = Object.fromEntries(known)
    const [first, ...rest] = fields
    if (!first) return yield* decode(values)

    const state = yield* forms
      .ask({
        sessionID: context.sessionID,
        title: definition.name,
        fields: [first, ...rest],
        metadata: { kind: "action", action: definition.name, tool: { messageID: context.messageID, id: context.id } },
        validate: (answer) =>
          decode({ ...values, ...answer }).pipe(
            Effect.match({ onSuccess: () => undefined, onFailure: (error) => error.message }),
          ),
      })
      .pipe(Effect.mapError((error) => new Tool.Error({ message: error.message })))
    if (state.status === "cancelled") return yield* Effect.die(new Form.CancelledError({ action: definition.name }))
    return yield* decode({ ...values, ...state.answer })
  })
  return { schema, collects: true, prepare }
})
