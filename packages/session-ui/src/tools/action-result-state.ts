import { CustomerReviews, FlightAction } from "@opencode/flight-action"

import type { ToolProps } from "./tool-renderer"

export function isActionResult(tool: string, metadata: ToolProps["metadata"]) {
  return tool === FlightAction.definition.name ||
    tool === CustomerReviews.name ||
    Object.hasOwn(metadata, "actionOutput") ||
    Object.hasOwn(metadata, "actionDiagnostic")
}
