export * as LightningEditor from "./lightning-editor.js"

import { Option, Schema } from "effect"

const nonblank = /^\s*\S.*/
export const NonblankText = Schema.String.check(Schema.isPattern(nonblank))
export const CalendarDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)).check(
  Schema.makeFilter((value) => {
    const day = new Date(value + "T00:00:00.000Z")
    return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value
  }, { expected: "a calendar date" }),
)

const StandardType = Schema.Literals(["lightning__textType", "lightning__dateType"])
type StandardType = typeof StandardType.Type

export type Field<Key extends string = string> = {
  readonly key: Key
  readonly title: string
  readonly type: "string"
  readonly required: boolean
  readonly format?: "date"
  readonly pattern?: string
  readonly placeholder?: string
  readonly default?: string
  readonly options?: readonly { value: string; label: string }[]
}
type Fields = readonly [Field, ...Field[]]

export function standardField<Key extends string, Required extends boolean>(
  key: Key,
  type: StandardType,
  title: string,
  required: Required,
): Field<Key> & { required: Required } {
  if (type === "lightning__dateType") return { key, title, type: "string", required, format: "date", placeholder: "YYYY-MM-DD" }
  return { key, title, type: "string", required, ...(required ? { pattern: nonblank.source } : {}) }
}

export type Registration = {
  readonly channel: string
  readonly definition: string
  readonly lightningType: string
  readonly fields: Fields
}

type Resource = { path: string; data: Schema.JsonObject }
type Bundle = { schema: Resource; editors: Readonly<Record<string, Resource>> }

const RootOverride = Schema.Struct({
  editor: Schema.Struct({
    componentOverrides: Schema.Struct({ $: Schema.Struct({ definition: Schema.NonEmptyString }) }),
  }),
})
const LinkedType = Schema.Struct({ "lightning:type": Schema.String })
const readOverride = Schema.decodeUnknownOption(RootOverride)
const readLinkedType = Schema.decodeUnknownOption(LinkedType)

const StandardSchema = Schema.Struct({
  "lightning:type": StandardType,
  type: Schema.optionalKey(Schema.Literal("string")),
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
})
const FlatSchema = Schema.Struct({
  type: Schema.Literal("object"),
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  properties: Schema.Record(Schema.String, StandardSchema),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
  additionalProperties: Schema.optionalKey(Schema.Literal(false)),
  unevaluatedProperties: Schema.optionalKey(Schema.Literal(false)),
})
const readScalar = Schema.decodeUnknownOption(StandardSchema, { onExcessProperty: "error" })
const readFlat = Schema.decodeUnknownOption(FlatSchema, { onExcessProperty: "error" })

export type EditorReference = { channel: string; definition: string; resource: string }
type Plan =
  | { kind: "registered"; editor: EditorReference; fields: Fields }
  | { kind: "standard"; fields: Fields }
  | { kind: "unavailable"; message: string }

export function resolve(
  bundle: Bundle,
  channel: string,
  parameter: string,
  registry: readonly Registration[],
): Plan {
  const override = Object.hasOwn(bundle.editors, channel) ? bundle.editors[channel] : undefined
  if (override) {
    const parsed = Option.getOrUndefined(readOverride(override.data))
    if (!parsed) return {
      kind: "unavailable",
      message: "Invalid editor definition for " + channel + " at " + override.path + "#$.editor.componentOverrides.$.definition.",
    }

    const definition = parsed.editor.componentOverrides.$.definition
    const schema = Option.getOrUndefined(readLinkedType(bundle.schema.data))
    const registered = registry.find((entry) =>
      entry.channel === channel && entry.definition === definition && entry.lightningType === schema?.["lightning:type"],
    )
    if (registered) return {
      kind: "registered",
      fields: registered.fields,
      editor: { channel, definition, resource: override.path },
    }

    const fields = standardFields(bundle.schema.data, parameter)
    if (fields) return { kind: "standard", fields }

    return {
      kind: "unavailable",
      message: "No editor for " + channel + " / " + definition + " at " + override.path +
        "#$.editor.componentOverrides.$.definition. The input cannot be flattened into standard fields.",
    }
  }

  const fields = standardFields(bundle.schema.data, parameter)
  if (fields) return { kind: "standard", fields }

  return { kind: "unavailable", message: "No standard editor for " + channel + " at " + bundle.schema.path + "." }
}

function standardFields(resource: Schema.JsonObject, parameter: string): Fields | undefined {
  const scalar = Option.getOrUndefined(readScalar(resource))
  if (scalar) return [standardField(parameter, scalar["lightning:type"], scalar.title ?? parameter, true)]

  const flat = Option.getOrUndefined(readFlat(resource))
  if (!flat || (flat.additionalProperties !== false && flat.unevaluatedProperties !== false)) return
  if (flat.required?.some((key) => !Object.hasOwn(flat.properties, key))) return

  const [first, ...rest] = Object.entries(flat.properties).map(([key, spec]) =>
    standardField(parameter + "." + key, spec["lightning:type"], spec.title ?? key, flat.required?.includes(key) ?? false),
  )
  if (first) return [first, ...rest]
}
