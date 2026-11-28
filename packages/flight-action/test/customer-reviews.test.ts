import { expect, test } from "bun:test"
import { CustomerReviews, Widget } from "@opencode/flight-action"

const reviews = {
  reviewCount: 2,
  averageRating: 4.5,
  items: [
    { customerName: "林青", rating: 5, orderDate: "2026-12-05", comments: "交付准时" },
    { customerName: "周岚", rating: 4, orderDate: "2026-12-06", comments: "包装完整" },
  ],
}

const envelope = {
  actionName: "GetCustomerReviewsAction",
  isSuccess: true,
  outputValues: { isSuccess: true, message: "Successfully retrieved 2 reviews", reviews },
}

test("maps the Pronto Invocable envelope to the same review fields as a direct result", () => {
  expect(CustomerReviews.bind({ reviews }).view?.attributes).toEqual(reviews)
  expect(CustomerReviews.invocable(envelope)).toEqual({ reviews })

  const empty = { reviewCount: 0, averageRating: 0, items: [] }
  expect(CustomerReviews.invocable({ ...envelope, outputValues: { isSuccess: true, reviews: empty } })).toEqual({
    reviews: empty,
  })
})

test("keeps reviews with nullable Apex fields renderable without changing their business values", () => {
  const result = {
    ...reviews,
    items: [{ customerName: null, rating: null, orderDate: null, comments: null }, reviews.items[1]!],
  }
  const wrapped = CustomerReviews.invocable({ ...envelope, outputValues: { isSuccess: true, reviews: result } })
  expect(wrapped).toEqual({ reviews: result })

  const bound = CustomerReviews.bind({ reviews: result })
  expect(bound.view?.attributes.items).toHaveLength(2)
  expect(() => Widget.render(CustomerReviews.widget, CustomerReviews.resource, bound.view!.attributes)).not.toThrow()
})

test.each([
  ["outer", { actionName: envelope.actionName, isSuccess: false }, "$.structuredContent.isSuccess"],
  ["inner", { ...envelope, outputValues: { isSuccess: false, message: "Review service unavailable", reviews: null } },
    "$.structuredContent.outputValues.isSuccess"],
] as const)("identifies an unsuccessful %s action without treating it as an empty list", (_, value, path) => {
  expect(CustomerReviews.invocable(value)).toEqual({ diagnostic: { stage: "actionResult", path } })
})

test.each([
  ["outer status text", { ...envelope, isSuccess: "false" }, "$.structuredContent.isSuccess"],
  ["inner status text", { ...envelope, outputValues: { isSuccess: "false", reviews } }, "$.structuredContent.outputValues.isSuccess"],
  ["outer extra field", { ...envelope, undeclared: "extra" }, "$.structuredContent.undeclared"],
  ["inner extra field", { ...envelope, outputValues: { ...envelope.outputValues, undeclared: "extra" } },
    "$.structuredContent.outputValues.undeclared"],
  ["response array", { ...envelope, outputValues: [] }, "$.structuredContent.outputValues"],
  ["missing binding", { ...envelope, outputValues: { isSuccess: true } }, "$.structuredContent.outputValues.reviews"],
  ["list object", { ...envelope, outputValues: { isSuccess: true, reviews: { ...reviews, items: {} } } },
    "$.structuredContent.outputValues.reviews.items"],
  ["number text", { ...envelope, outputValues: { isSuccess: true, reviews: { ...reviews, averageRating: "4.5" } } },
    "$.structuredContent.outputValues.reviews.averageRating"],
] as const)("pinpoints invalid Pronto data (%s)", (_, value, path) => {
  expect(CustomerReviews.invocable(value)).toEqual({ diagnostic: { stage: "actionSchema", path } })
})
