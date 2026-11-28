export * as ActionOutput from "./action-output.js"

import { Schema } from "effect"
import { WidgetResource } from "@opencode/schema/widget-resource"

type Policy = { readonly is_displayable?: boolean; readonly filter_from_agent?: boolean }
type Projections = { readonly user: Schema.JsonObject; readonly model: Schema.JsonObject }

export type Binding<View> = { view?: View; path?: string; rejectedOutput?: string }

export const Diagnostic = Schema.Struct({
  stage: Schema.Literals(["call", "structured", "mcpSchema", "actionSchema", "actionResult", "widget"]),
  path: Schema.String,
})
export type Diagnostic = typeof Diagnostic.Type

export const View = Schema.Struct({
  id: Schema.NonEmptyString,
  ...WidgetResource.Definition.fields,
})
export type View = typeof View.Type

export const Presentation = Schema.Struct({
  outputs: Schema.JsonObject,
  widget: Schema.optionalKey(Schema.String),
  view: Schema.optionalKey(View),
})
export type Presentation = typeof Presentation.Type

/** One policy governs the entire named value. Undeclared outputs stay out of both projections. */
export function project(policies: Readonly<Record<string, Policy>>, validated: Schema.JsonObject): Projections {
  const entries = Object.entries(policies).flatMap(([name, policy]) => {
    const value = validated[name]
    return Object.hasOwn(validated, name) && value !== undefined ? [{ name, policy, value }] : []
  })
  return {
    user: Object.fromEntries(entries.filter(({ policy }) => policy.is_displayable === true).map(({ name, value }) => [name, value])),
    model: Object.fromEntries(entries.filter(({ policy }) => policy.filter_from_agent !== true).map(({ name, value }) => [name, value])),
  }
}

export function result(projections: Projections, widget?: string | View) {
  const presentation =
    typeof widget === "object" ? { view: widget }
    : widget !== undefined && Object.keys(projections.user).length > 0 ? { widget }
    : {}

  return {
    content: JSON.stringify(projections.model),
    metadata: {
      actionOutput: {
        outputs: projections.user,
        ...presentation,
      },
    },
  }
}
