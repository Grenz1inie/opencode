export * as FlightAction from "./flight-action.js"

export { ActionOutput } from "./action-output.js"

import { Schema, SchemaIssue } from "effect"
import { ActionOutput } from "./action-output.js"

// The same pattern runs with implicit whole-value matching in HTML inputs.
const nonblank = /^\s*\S.*/
const city = Schema.String.check(Schema.isPattern(nonblank))
const date = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)).check(
  Schema.makeFilter((value) => {
    const day = new Date(`${value}T00:00:00.000Z`)
    return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value
  }, { expected: "a calendar date" }),
)

export const Input = Schema.Struct({
  originCity: city.annotate({ description: "The origin city provided by the user." }),
  destinationCity: city.annotate({ description: "The destination city provided by the user." }),
  dateOfTravel: date.annotate({ description: "The travel date specified by the user, YYYY-MM-DD. Omit if unknown." }),
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

type InputKey = keyof Input
type InputPolicy = Partial<Record<InputKey, { is_required?: boolean; is_user_input?: boolean }>>
const inputKeys = ["originCity", "destinationCity", "dateOfTravel"] as const
const labels = { originCity: "Origin city", destinationCity: "Destination city", dateOfTravel: "Departure date" }
const Draft = Schema.Struct({
  originCity: Schema.optionalKey(Schema.Unknown),
  destinationCity: Schema.optionalKey(Schema.Unknown),
  dateOfTravel: Schema.optionalKey(Schema.Unknown),
})

export function formable(key: string, policy: InputPolicy = definition.inputs) {
  return inputKeys.some((field) => field === key && policy[field]?.is_user_input === true)
}

export function prepare(input: unknown, policy: InputPolicy = definition.inputs) {
  const draft = Schema.decodeUnknownSync(Draft)(input)
  const values: Partial<Record<InputKey, string>> = {}
  const fields = inputKeys.flatMap((key) => {
    const value = Schema.decodeUnknownOption(Input.fields[key])(draft[key])
    if (value._tag === "Some") {
      values[key] = value.value
      return []
    }
    if (policy[key]?.is_required !== true) return []
    if (!formable(key, policy)) throw new Error(`Missing or invalid input: ${labels[key]}`)
    return [{
      key,
      title: labels[key],
      type: "string" as const,
      required: true,
      ...(definition.inputs[key].lightningType === "lightning__dateType"
        ? { format: "date" as const, placeholder: "YYYY-MM-DD" }
        : { pattern: nonblank.source }),
    }]
  })
  return { values, fields }
}

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
export const widget = override.definition

export const View = Schema.Struct({
  definition: Schema.Literal(override.definition),
  attributes: Results,
})
export type View = typeof View.Type

export function simulate(input: Input): Results {
  return {
    ...input,
    flights: [
      { number: "CA 1741", departure: "08:20", arrival: "11:10", duration: "2h 50m", fare: input.dateOfTravel === "2026-12-06" ? 570 : 560 },
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
  const projections = ActionOutput.project(definition.outputs, { results })
  const bound = bind(projections.user)
  return {
    user: bound.view,
    model: projections.model,
    tool: ActionOutput.result(projections, Object.hasOwn(projections.user, "results") ? widget : undefined),
  }
}

const decodeResults = Schema.decodeUnknownResult(Results)
const decodeView = Schema.decodeUnknownResult(View)
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

export function bind(outputs: Schema.JsonObject): ActionOutput.Binding<View> {
  if (!Object.hasOwn(outputs, "results")) return { path: "$.outputs.results" }

  const results = decodeResults(outputs.results)
  if (results._tag === "Failure") {
    const path = formatIssues(results.failure.issue).issues[0]?.path
    return {
      rejectedOutput: "results",
      path: "$.outputs.results" + (path?.length ? "." + path.map(String).join(".") : ""),
    }
  }

  const attributes = Object.fromEntries(
    Object.entries(override.attributes).map(([name, expression]) => [name, readBinding(expression, { $attrs: results.success })]),
  )
  const decoded = decodeView({ definition: widget, attributes })
  if (decoded._tag === "Success") return { view: decoded.success }
  const path = formatIssues(decoded.failure.issue).issues[0]?.path
  return { path: "$" + (path?.length ? "." + path.map(String).join(".") : ".attributes") }
}

export function readBinding(expression: string, scope: Readonly<Record<string, unknown>>): unknown {
  const path = /^\{!([$\w]+(?:\.\w+)+)\}$/.exec(expression)?.[1]
  return path?.split(".").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined
    // SAFETY: the JSON binding reads one checked own property, including reactive store properties.
    return (value as Readonly<Record<string, unknown>>)[key]
  }, scope)
}
