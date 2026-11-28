import { expect, test } from "bun:test"
import { FlightAction } from "@opencode/flight-action"
import type { ActionConfig } from "@opencode/schema/mcp"
import { Effect } from "effect"
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
