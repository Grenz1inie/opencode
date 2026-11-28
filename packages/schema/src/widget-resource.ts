export * as WidgetResource from "./widget-resource.js"

import { Schema } from "effect"

export type Node = {
  readonly definition: string
  readonly id?: string
  readonly attributes?: Readonly<Record<string, Schema.Json | undefined>>
  readonly children?: readonly Node[]
  readonly meta?: { readonly forEach?: string; readonly forItem?: string; readonly if?: string }
}

export const Node: Schema.Codec<Node> = Schema.Struct({
  definition: Schema.NonEmptyString,
  id: Schema.optionalKey(Schema.String),
  attributes: Schema.optionalKey(Schema.JsonObject),
  children: Schema.optionalKey(Schema.Array(Schema.suspend(() => Node))),
  meta: Schema.optionalKey(
    Schema.Struct({
      forEach: Schema.optionalKey(Schema.String),
      forItem: Schema.optionalKey(Schema.String),
      if: Schema.optionalKey(Schema.String),
    }),
  ),
})

export const Definition = Schema.Struct({
  label: Schema.NonEmptyString,
  body: Node,
})
export type Definition = typeof Definition.Type
