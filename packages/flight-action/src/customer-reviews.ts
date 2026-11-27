export * as CustomerReviews from "./customer-reviews.js"

import { Schema, SchemaIssue } from "effect"
import { ActionOutput } from "./action-output.js"
import { Widget } from "./widget.js"
import mapping from "./resources/pronto/lightningTypes/customerReviewsOutput/renderer.json" with { type: "json" }
import outputType from "./resources/pronto/lightningTypes/customerReviewsOutput/schema.json" with { type: "json" }
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
export const widget = override.definition
export const name = "get_customer_reviews"
export const Input = Schema.Struct({ empty: Schema.optionalKey(Schema.Boolean) })
export const resource = composition.contentBody.widgetBody

const acceptedOutput = apexTypes.get(outputType["lightning:type"])
const itemType = apexTypes.get(fields.items.items["lightning:type"])
if (acceptedOutput !== wrapper || itemType !== item) throw new Error("Pronto Apex types are not registered")
const decodeOutput = Schema.decodeUnknownResult(acceptedOutput)
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

export function bind(outputs: Schema.JsonObject) {
  const decoded = decodeOutput(outputs.reviews)
  if (decoded._tag === "Failure") {
    const path = format(decoded.failure.issue).issues[0]?.path
    return {
      rejectedOutput: "reviews",
      path: "$.outputs.reviews" + (path?.length ? "." + path.map(String).join(".") : ""),
    }
  }
  try {
    const attributes = Object.fromEntries(
      Object.entries(override.attributes).map(([key, expression]) => [key, Widget.bind(expression, { $attrs: decoded.success })]),
    )
    const bound = decodeAttributes(attributes)
    if (bound._tag === "Failure") {
      const path = format(bound.failure.issue).issues[0]?.path
      return { path: "$.attributes" + (path?.length ? "." + path.map(String).join(".") : "") }
    }
    return { view: { definition: widget, attributes: bound.success } }
  } catch {
    return { path: "$.renderer.componentOverrides.$.attributes" }
  }
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
  return ActionOutput.result(ActionOutput.project({ reviews: { is_displayable: true } }, output), widget)
}
