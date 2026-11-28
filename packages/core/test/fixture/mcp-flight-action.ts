import { Server, type Tool } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { FlightAction } from "@opencode/flight-action"
import { Schema } from "effect"
import { appendFileSync } from "node:fs"

const server = new Server({ name: "flight-action", version: "1.0.0" }, { capabilities: { tools: {} } })
const inputSchema = {
  type: "object",
  properties: {
    originCity: { type: "string" },
    destinationCity: { type: "string" },
    dateOfTravel: { type: "string" },
    scenario: { type: "string" },
  },
  required: ["originCity", "destinationCity", "dateOfTravel"],
} as const satisfies Tool["inputSchema"]
const outputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { contract: { const: "flight-results" }, results: { type: "object" } },
  required: ["contract", "results"],
} as const satisfies Tool["outputSchema"]
const trip = Schema.decodeUnknownSync(FlightAction.Input)

server.setRequestHandler("tools/list", async () => ({
  tools: ["search", "no_schema", "bad_widget", "ordinary"].map((name) => ({
    name,
    inputSchema,
    ...(name === "no_schema" ? {} : { outputSchema }),
  })),
}))

server.setRequestHandler("tools/call", async ({ params }) => {
  const input = trip(params.arguments)
  const scenario = params.arguments?.scenario
  const log = process.env.MCP_ACTION_LOG

  if (log) appendFileSync(log, JSON.stringify({ tool: params.name, input, scenario }) + "\n")

  const flights = FlightAction.simulate(input)
  const structured = {
    contract: "flight-results",
    results: scenario === "visibility" || params.name === "bad_widget" ? { ...flights, originCity: "BOTH_8_MARKER" } : flights,
    userOnly: "USER_8_MARKER",
    modelOnly: "MODEL_8_MARKER",
    hidden: "NEITHER_8_MARKER",
    defaulted: "DEFAULT_8_MARKER",
    unregistered: "UNREGISTERED_8_MARKER",
  }
  const content = [{ type: "text" as const, text: JSON.stringify(structured) }]
  const mismatch = { ...structured, contract: "other" }

  switch (scenario) {
    case "missing":
      return { content: [] }
    case "text":
      return { content }
    case "mcp":
      return { content, structuredContent: mismatch }
    case "action":
      return { content, structuredContent: { ...structured, results: { ...flights, flights: "INVALID_8_MARKER" } } }
    case "error":
      return { content, structuredContent: mismatch, isError: true }
    default:
      return { content, structuredContent: structured }
  }
})

await server.connect(new StdioServerTransport())
