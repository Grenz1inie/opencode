import { FlightAction } from "@opencode/flight-action"

export function isActionResult(tool: string, metadata: object) {
  return tool === FlightAction.definition.name || Object.hasOwn(metadata, "actionOutput")
}
