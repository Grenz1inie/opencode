import { ToolFailure } from "@opencode/ai/effect"
import { ActionOutput, CustomerReviews, FlightAction } from "@opencode/flight-action"
import type { ActionConfig } from "@opencode/schema/mcp"
import { Effect, Schema } from "effect"
import type { Mcp } from "../mcp/index.js"

const decodeStructured = Schema.decodeUnknownResult(Schema.JsonObject)
const decodeResults = Schema.decodeUnknownResult(FlightAction.Results)

type OutputSchema = NonNullable<Mcp.Tool["outputSchema"]>
type Check = (value: Schema.Json) => boolean
const validators = new WeakMap<OutputSchema, Promise<Check>>()

async function compileValidator(schema: OutputSchema) {
  const { DefaultJsonSchemaValidator } = await import("@modelcontextprotocol/client/_shims")
  const check = new DefaultJsonSchemaValidator().getValidator(schema)
  return (value: Schema.Json) => check(value).valid
}

function validator(schema: OutputSchema) {
  const cached = validators.get(schema)
  if (cached) return cached

  // Each declared schema owns its validator so equal $ids on different tools or revisions cannot collide.
  const compiled = compileValidator(schema)
  validators.set(schema, compiled)
  return compiled
}

export function mcpActionFailure(
  stage: ActionOutput.Diagnostic["stage"],
  path = stage === "call" ? "$" : "$.structuredContent",
  outputs: Schema.JsonObject = {},
) {
  return new ToolFailure({
    message: `MCP Action failed (${stage}: ${path})`,
    metadata: { actionDiagnostic: { stage, path }, actionOutput: { outputs } },
  })
}

export const projectMcpAction = Effect.fnUntraced(function* (
  action: ActionConfig,
  outputSchema: Mcp.Tool["outputSchema"],
  result: Mcp.ToolResult,
) {
  // MCP permits a JSON text copy for compatibility. Registered Actions consume only structuredContent.
  if (result.isError) return yield* mcpActionFailure("call")

  // Salesforce sends the registered Pronto action's single envelope in a list.
  const array = action.type === "customerReviews" && Array.isArray(result.structured) && result.structured.length === 1
    ? result.structured
    : undefined
  const path = array ? "$.structuredContent[0]" : "$.structuredContent"
  const structured = decodeStructured(array ? array[0] : result.structured)
  if (structured._tag === "Failure") return yield* mcpActionFailure("structured", path)

  const parsed = action.type === "customerReviews" ? CustomerReviews.invocable(structured.success, path) : undefined
  if (parsed && "diagnostic" in parsed && parsed.diagnostic.stage === "actionResult")
    return yield* mcpActionFailure(parsed.diagnostic.stage, parsed.diagnostic.path)

  if (outputSchema) {
    const value = array && outputSchema.type === "array" ? [structured.success] : structured.success
    yield* Effect.tryPromise({
      try: async () => {
        const check = await validator(outputSchema)
        if (!check(value)) throw new Error("Invalid MCP output")
      },
      catch: () => mcpActionFailure("mcpSchema"),
    })
  }

  if (parsed) {
    if ("diagnostic" in parsed) return yield* mcpActionFailure(parsed.diagnostic.stage, parsed.diagnostic.path)

    const projections = ActionOutput.project({ ...CustomerReviews.outputs, ...action.outputs }, { reviews: parsed.reviews })
    const widget = Object.hasOwn(projections.user, "reviews") ? CustomerReviews.widget : undefined
    return { output: projections.model, ...ActionOutput.result(projections, widget) }
  }

  const results = decodeResults(structured.success.results)
  if (results._tag === "Failure") return yield* mcpActionFailure("actionSchema", "$.structuredContent.results")

  const projections = ActionOutput.project(
    { ...FlightAction.definition.outputs, ...action.outputs },
    { ...structured.success, results: results.success },
  )
  const binding = FlightAction.bind({ results: results.success }, action.attributes)
  if (!binding.view) return yield* mcpActionFailure("widget", binding.path ?? "$.attributes", projections.user)

  const visible = Object.hasOwn(projections.user, "results")
  return {
    output: projections.model,
    ...ActionOutput.result(
      {
        model: projections.model,
        user: visible ? { ...projections.user, results: binding.view.attributes } : projections.user,
      },
      visible ? FlightAction.widget : undefined,
    ),
  }
})
