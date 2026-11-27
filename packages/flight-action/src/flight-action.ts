export * as FlightAction from "./flight-action.js"

import { Schema } from "effect"

const city = Schema.String.check(Schema.isPattern(/\S/))
const date = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)).check(
  Schema.makeFilter((value) => {
    const day = new Date(`${value}T00:00:00.000Z`)
    return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value
  }, { expected: "a calendar date" }),
)

export const Input = Schema.Struct({
  originCity: city,
  destinationCity: city,
  dateOfTravel: date,
})
type Input = typeof Input.Type

const Flight = Schema.Struct({
  number: Schema.String,
  departure: Schema.String,
  arrival: Schema.String,
  duration: Schema.String,
  fare: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
})
const Results = Schema.Struct({ ...Input.fields, flights: Schema.Array(Flight) })
type Results = typeof Results.Type

export const definition = {
  name: "find_flights",
  target: "local://flight-search",
  inputs: {
    originCity: { lightningType: "lightning__textType", is_required: true, is_user_input: true },
    destinationCity: { lightningType: "lightning__textType", is_required: true, is_user_input: true },
    dateOfTravel: { lightningType: "lightning__dateType", is_required: true, is_user_input: true },
  },
  outputs: {
    results: { complex_data_type_name: "c__flightResults", is_displayable: true, filter_from_agent: false },
  },
} as const

export const renderer = {
  renderer: {
    componentOverrides: {
      $: {
        definition: "@widget/c/flightResults",
        attributes: {
          originCity: "{!$attrs.originCity}",
          destinationCity: "{!$attrs.destinationCity}",
          dateOfTravel: "{!$attrs.dateOfTravel}",
          flights: "{!$attrs.flights}",
        },
      },
    },
  },
} as const

const override = renderer.renderer.componentOverrides.$

export const View = Schema.Struct({
  definition: Schema.Literal(override.definition),
  attributes: Results,
})
export type View = typeof View.Type

export function simulate(input: Input): Results {
  return {
    ...input,
    flights: [
      { number: "CA 1741", departure: "08:20", arrival: "11:10", duration: "2h 50m", fare: 560 },
      { number: "MU 5495", departure: "14:10", arrival: "17:05", duration: "2h 55m", fare: 620 },
    ],
  }
}

const targets = { [definition.target]: simulate }
const lightningTypes = { c__flightResults: Results }

export function run(input: unknown, target: (input: Input) => unknown = targets[definition.target]) {
  const output = definition.outputs.results
  const results = Schema.decodeUnknownSync(lightningTypes[output.complex_data_type_name])(
    target(Schema.decodeUnknownSync(Input)(input)),
  )
  const attributes = Object.fromEntries(
    Object.entries(override.attributes).map(([name, expression]) => [name, readBinding(expression, { $attrs: results })]),
  )
  return {
    user: output.is_displayable ? Schema.decodeUnknownSync(View)({ definition: override.definition, attributes }) : undefined,
    model: output.filter_from_agent ? undefined : { results },
  }
}

export function readBinding(expression: string, scope: Readonly<Record<string, unknown>>): unknown {
  const path = /^\{!([$\w]+(?:\.\w+)+)\}$/.exec(expression)?.[1]
  return path?.split(".").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined
    return Object.getOwnPropertyDescriptor(value, key)?.value
  }, scope)
}
