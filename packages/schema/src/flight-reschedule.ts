export * as FlightReschedule from "./flight-reschedule.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"

export const Card = Schema.Struct({
  sessionID: Schema.String,
  messageID: Schema.String,
  callID: Schema.String,
})
export type Card = typeof Card.Type

export const Result = Schema.Struct({
  revision: Schema.String,
  outputs: Schema.JsonObject,
})
export type Result = typeof Result.Type

export const Change = Schema.Struct({
  card: Card,
  revision: Schema.String,
  operation: Schema.Struct({
    widget: Schema.String,
    node: Schema.String,
    definition: Schema.String,
  }),
})

export type Change = typeof Change.Type

export const Changed = Schema.Struct({ card: Card, result: Result })
export type Changed = typeof Changed.Type

const response = Schema.toStandardSchemaV1(Schema.NullOr(Result))
const errors = { Unavailable: Schema.toStandardSchemaV1(Schema.Null) }

export const Definition = Rpc.define({
  id: "opencode.flight-reschedule",
  methods: {
    get: { input: Schema.toStandardSchemaV1(Card), output: response, errors },
    change: { input: Schema.toStandardSchemaV1(Change), output: response, errors },
  },
  events: {
    changed: { schema: Schema.toStandardSchemaV1(Changed) },
  },
})
