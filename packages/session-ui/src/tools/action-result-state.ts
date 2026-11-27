import { CustomerReviews, FlightAction } from "@opencode/flight-action"

export function isActionResult(tool: string, metadata: object) {
  return tool === FlightAction.definition.name || tool === CustomerReviews.name || Object.hasOwn(metadata, "actionOutput")
}
