import { expect, test } from "bun:test"
import { CustomerReviews, Widget } from "../src/flight-action.js"

test("preserves exact binding values and scopes repeated rows", () => {
  const items = [{ name: "Ada", rating: 5 }, { name: "Lin", rating: 4 }]
  const scope = { $attrs: { items, average: 4.5, empty: false, missing: null } }
  expect(Widget.bind("{!$attrs.items}", scope)).toBe(items)
  expect(Widget.bind("{!$attrs.average}", scope)).toBe(4.5)
  expect(Widget.bind("{!$attrs.empty}", scope)).toBe(false)
  expect(Widget.bind("{!$attrs.missing}", scope)).toBeNull()
  const tree = Widget.render("test", {
    definition: "tile/widget",
    children: [{
      definition: "tile/text",
      meta: { forEach: "{!$attrs.items}" },
      attributes: { text: "{!$Item.name}: {!$Item.rating}/5" },
    }],
  }, { items })
  expect(tree.children.map((node) => node.text)).toEqual(["Ada: 5/5", "Lin: 4/5"])
})

test("only true shows a conditional and errors identify resource and node", () => {
  const node = {
    definition: "tile/widget",
    children: [{ definition: "tile/text", meta: { if: "{!$attrs.show}" }, attributes: { text: "shown" } }],
  }
  expect(Widget.render("conditional", node, {show:true}).children).toHaveLength(1)
  for (const attrs of [{show:false}, {}, {show:null}]) {
    expect(Widget.render("conditional", node, attrs).children).toHaveLength(0)
  }
  expect(() => Widget.render("conditional", node, {show:"false"})).toThrow("conditional · $.children[0].meta.if")
  expect(() => Widget.render("bad", { definition: "tile/text", attributes: { text: "{!$attrs.x + 1}" } }, {}))
    .toThrow("bad · $.attributes.text")
  expect(() => Widget.render("bad", { definition: "tile/text", attributes: { text: "{!$review.name}" } }, {}))
    .toThrow("bad · $.attributes.text: Unknown binding scope")
})

test("registers the original review shapes and diagnoses invalid output bindings", () => {
  const reviews = CustomerReviews.sample(false)
  const view = CustomerReviews.bind({ reviews })
  expect(view.path).toBeUndefined()
  expect(view.view?.attributes.items).toEqual(reviews.items)
  expect(CustomerReviews.bind({ reviews: { ...reviews, items: [{ ...reviews.items[0], rating: "5" }] } }).path)
    .toBe("$.outputs.reviews.items.0.rating")
  expect(CustomerReviews.bind({ reviews: { averageRating: 4.5, items: [] } }).path).toBe("$.outputs.reviews.reviewCount")
})
