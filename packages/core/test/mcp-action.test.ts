import { expect, test } from "bun:test"
import { CustomerReviews, FlightAction } from "@opencode/flight-action"
import type { ActionConfig } from "@opencode/schema/mcp"
import { Effect, type Schema } from "effect"
import { projectMcpAction } from "../src/tool/mcp-action.js"

const action = {
  type: "find_flights",
  outputs: {
    forUser: { is_displayable: true, filter_from_agent: true },
    forModel: {},
    hidden: { is_displayable: false, filter_from_agent: true },
  },
} satisfies ActionConfig

const results = FlightAction.simulate({ originCity: "杭州", destinationCity: "成都", dateOfTravel: "2026-12-05" })
const structured = { results, contract: "v1", forUser: "user", forModel: "model", hidden: "neither", other: "undeclared" }
const content = [{ type: "text" as const, text: JSON.stringify(structured) }]
const response = { isError: false, structured, content }

const outputSchema = (contract: string) => ({
  $id: "https://example.test/flight-action-output",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { contract: { const: contract }, results: { type: "object" } },
  required: ["contract", "results"],
})

test("projects structured MCP Action results once per audience and drops the text copy", async () => {
  const expected = {
    output: { results, forModel: "model" },
    content: JSON.stringify({ results, forModel: "model" }),
    metadata: { actionOutput: { widget: FlightAction.widget, outputs: { results, forUser: "user" } } },
  }

  expect(await Effect.runPromise(projectMcpAction(action, outputSchema("v1"), response))).toEqual(expected)
  expect(await Effect.runPromise(projectMcpAction(action, undefined, response))).toEqual(expected)
})

test("fails the current Action at its first invalid stage without rendering raw text", async () => {
  const badWidget = { ...action, attributes: { flights: "{!$attrs.dateOfTravel}" } }
  const invalid = { ...structured, results: { ...results, flights: "not an array" } }
  const schema = outputSchema("v1")

  for (const [stage, path, failure] of [
    ["call", "$", projectMcpAction(badWidget, outputSchema("v2"), { isError: true, content })],
    ["structured", "$.structuredContent", projectMcpAction(action, schema, { isError: false, content: [] })],
    ["structured", "$.structuredContent", projectMcpAction(action, schema, { isError: false, content })],
    ["mcpSchema", "$.structuredContent", projectMcpAction(action, outputSchema("v2"), response)],
    ["actionSchema", "$.structuredContent.results", projectMcpAction(action, schema, { ...response, structured: invalid })],
    ["widget", "$.attributes.flights", projectMcpAction(badWidget, schema, response)],
  ] as const) {
    const error = await Effect.runPromise(Effect.flip(failure))

    expect(error.metadata).toEqual({
      actionDiagnostic: { stage, path },
      actionOutput: { outputs: stage === "widget" ? { results, forUser: "user" } : {} },
    })
  }
})

const pronto = { type: "customerReviews" } satisfies ActionConfig
const reviews = CustomerReviews.sample(false)
const envelope = {
  actionName: "GetCustomerReviewsAction",
  isSuccess: true,
  outputValues: { isSuccess: true, message: "ENVELOPE_ONLY_MESSAGE", reviews },
}
const prontoResponse = { isError: false, structured: envelope, content: [{ type: "text" as const, text: "RAW_ENVELOPE" }] }

test.each([
  [true, false, true, true],
  [true, true, true, false],
  [false, false, false, true],
  [false, true, false, false],
] as const)("projects Pronto reviews with is_displayable=%s and filter_from_agent=%s", async (
  is_displayable,
  filter_from_agent,
  user,
  model,
) => {
  const binding = { ...pronto, outputs: { reviews: { is_displayable, filter_from_agent } } }
  const expectedModel: Schema.JsonObject = model ? { reviews } : {}

  const expectedUser: Schema.JsonObject = user ? { reviews } : {}
  expect(await Effect.runPromise(projectMcpAction(binding, undefined, prontoResponse))).toEqual({
    output: expectedModel,
    content: JSON.stringify(expectedModel),
    metadata: {
      actionOutput: user ? { widget: CustomerReviews.widget, outputs: expectedUser } : { outputs: expectedUser },
    },
  })
})

test("keeps a field diagnostic when a declared MCP schema rejects the same Pronto field", async () => {
  const schema = {
    type: "object",
    properties: { outputValues: { type: "object", properties: { isSuccess: { type: "boolean" } } } },
  } as const
  const invalid = {
    ...prontoResponse,
    structured: { ...envelope, outputValues: { ...envelope.outputValues, isSuccess: "true" } },
  }
  const error = await Effect.runPromise(Effect.flip(projectMcpAction(pronto, schema, invalid)))

  expect(error.metadata).toEqual({
    actionDiagnostic: { stage: "mcpSchema", path: "$.structuredContent.outputValues.isSuccess" },
    actionOutput: { outputs: {} },
  })
})

test("preserves the Pronto failure stage and path without exposing its envelope or text copy", async () => {
  const failed = {
    ...prontoResponse,
    structured: { ...envelope, outputValues: { ...envelope.outputValues, isSuccess: false, reviews: null } },
  }
  const error = await Effect.runPromise(Effect.flip(projectMcpAction(pronto, undefined, failed)))

  expect(error.metadata).toEqual({
    actionDiagnostic: { stage: "actionResult", path: "$.structuredContent.outputValues.isSuccess" },
    actionOutput: { outputs: {} },
  })
})
