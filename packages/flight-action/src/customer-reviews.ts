export * as CustomerReviews from "./customer-reviews.js"

import { Schema, SchemaIssue } from "effect"
import { ActionOutput } from "./action-output.js"
import { Widget } from "./widget.js"
import mapping from "./resources/pronto/lightningTypes/customerReviewsOutput/renderer.json" with { type: "json" }
import outputType from "./resources/pronto/lightningTypes/customerReviewsOutput/schema.json" with { type: "json" }
import envelopeType from "./resources/pronto/lightningTypes/customerReviews/schema.json" with { type: "json" }
import responseType from "./resources/pronto/lightningTypes/customerReviewsResponse/schema.json" with { type: "json" }
import invocableMapping from "./resources/pronto/lightningTypes/customerReviews/renderer.json" with { type: "json" }
import composition from "./resources/pronto/uiWidgets/customerReviews/customerReviews.json" with { type: "json" }
import attributeType from "./resources/pronto/uiWidgets/customerReviews/schema.json" with { type: "json" }

const orderDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)).check(
  Schema.makeFilter((value) => {
    const day = new Date(`${value}T00:00:00.000Z`)
    return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value
  }, { expected: "a calendar date" }),
)
const decimal = Schema.Number.check(Schema.isFinite())
const item = Schema.Struct({
  customerName: Schema.String,
  rating: decimal,
  orderDate,
  comments: Schema.String,
})
const wrapper = Schema.Struct({ reviewCount: Schema.Int, averageRating: decimal, items: Schema.Array(item) })
const apexTypes = new Map<string, typeof wrapper | typeof item>([
  ["@apexClassType/c__GetCustomerReviewsAction$ReviewWrapper", wrapper],
  ["@apexClassType/c__GetCustomerReviewsAction$ReviewItemWrapper", item],
])
const fields = attributeType.properties.attributes.properties
const override = mapping.renderer.componentOverrides.$
const invocableOverride = invocableMapping.renderer.componentOverrides.$
export const widget = override.definition
export const name = "get_customer_reviews"
export const outputs = { reviews: { is_displayable: true } } as const
export const Input = Schema.Struct({ empty: Schema.optionalKey(Schema.Boolean) })
export const resource = composition.contentBody.widgetBody

const acceptedOutput = apexTypes.get(outputType["lightning:type"])
const itemType = apexTypes.get(fields.items.items["lightning:type"])
if (acceptedOutput !== wrapper || itemType !== item) throw new Error("Pronto Apex types are not registered")
if (
  envelopeType.properties.outputValues["lightning:type"] !== "c__customerReviewsResponse" ||
  apexTypes.get(responseType.properties.reviews["lightning:type"]) !== acceptedOutput ||
  invocableOverride.definition !== widget
) throw new Error("Pronto Invocable review resources do not match")

const decodeOutput = Schema.decodeUnknownResult(acceptedOutput)
const decodeEnvelope = Schema.decodeUnknownResult(Schema.Struct({
  actionName: Schema.optionalKey(Schema.String),
  isSuccess: Schema.Boolean,
  outputValues: Schema.optionalKey(Schema.Unknown),
}), { onExcessProperty: envelopeType.unevaluatedProperties === false ? "error" : "ignore" })
const decodeResponse = Schema.decodeUnknownResult(Schema.Struct({
  isSuccess: Schema.Boolean,
  message: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reviews: Schema.optionalKey(Schema.Unknown),
}), { onExcessProperty: responseType.unevaluatedProperties === false ? "error" : "ignore" })
const decodeAttributes = Schema.decodeUnknownResult(Schema.Struct({
  reviewCount: lightningNumber(fields.reviewCount["lightning:type"]),
  averageRating: lightningNumber(fields.averageRating["lightning:type"]),
  items: Schema.Array(itemType),
}))
function lightningNumber(type: string) {
  if (type !== "lightning__numberType") throw new Error("Unsupported review attribute type")
  return decimal
}

const format = SchemaIssue.makeFormatterStandardSchemaV1()

function issuePath(issue: SchemaIssue.Issue, prefix: string) {
  const path = format(issue).issues[0]?.path
  return prefix + (path?.length ? "." + path.map(String).join(".") : "")
}

function bindAttributes(renderer: typeof override, value: unknown) {
  try {
    const attributes = Object.fromEntries(
      Object.entries(renderer.attributes).map(([key, expression]) => [key, Widget.bind(expression, { $attrs: value })]),
    )
    const bound = decodeAttributes(attributes)
    if (bound._tag === "Failure") return { path: issuePath(bound.failure.issue, "$.attributes") }

    return { view: { definition: widget, attributes: bound.success } }
  } catch {
    return { path: "$.renderer.componentOverrides.$.attributes" }
  }
}

export function bind(outputs: Schema.JsonObject): ActionOutput.Binding<{ definition: string; attributes: typeof wrapper.Type }> {
  const decoded = decodeOutput(outputs.reviews)
  if (decoded._tag === "Failure")
    return { rejectedOutput: "reviews", path: issuePath(decoded.failure.issue, "$.outputs.reviews") }

  return bindAttributes(override, decoded.success)
}

type Invocable = { reviews: typeof wrapper.Type } | { diagnostic: ActionOutput.Diagnostic }

export function invocable(value: unknown): Invocable {
  const outerPath = "$.structuredContent"
  const innerPath = outerPath + ".outputValues"
  const outer = decodeEnvelope(value)
  if (outer._tag === "Failure")
    return { diagnostic: { stage: "actionSchema", path: issuePath(outer.failure.issue, outerPath) } }
  if (!outer.success.isSuccess)
    return { diagnostic: { stage: "actionResult", path: outerPath + ".isSuccess" } }

  const inner = decodeResponse(outer.success.outputValues)
  if (inner._tag === "Failure")
    return { diagnostic: { stage: "actionSchema", path: issuePath(inner.failure.issue, innerPath) } }
  if (!inner.success.isSuccess)
    return { diagnostic: { stage: "actionResult", path: innerPath + ".isSuccess" } }

  const reviews = decodeOutput(inner.success.reviews)
  if (reviews._tag === "Failure")
    return { diagnostic: { stage: "actionSchema", path: issuePath(reviews.failure.issue, innerPath + ".reviews") } }

  const bound = bindAttributes(invocableOverride, { ...outer.success, outputValues: { ...inner.success, reviews: reviews.success } })
  if (!bound.view) return { diagnostic: { stage: "widget", path: bound.path } }

  return { reviews: bound.view.attributes }
}

export function sample(empty: boolean): typeof wrapper.Type {
  if (empty) return { reviewCount: 0, averageRating: 0, items: [] }
  return {
    reviewCount: 2,
    averageRating: 4.5,
    items: [
      { customerName: "林青", rating: 5, orderDate: "2026-12-05", comments: "交付准时" },
      { customerName: "周岚", rating: 4, orderDate: "2026-12-06", comments: "包装完整" },
    ],
  }
}

export function run(input: typeof Input.Type) {
  const output = { reviews: sample(input.empty === true) }
  return ActionOutput.result(ActionOutput.project(outputs, output), widget)
}
