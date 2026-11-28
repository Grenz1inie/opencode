import { expect, test } from "@playwright/test"
import { FlightAction } from "@opencode/flight-action"
import { assistantMessage, partUpdated, setupTimeline, toolPart, userMessage } from "../utils/timeline"

test("renders flight cards from the tool's user projection at 390 pixels", async ({ page }) => {
  const trip = { originCity: "杭州", destinationCity: "成都", dateOfTravel: "2026-12-05" }
  const name = FlightAction.definition.name
  const id = "prt_flight_action"

  const timeline = await setupTimeline(page, {
    viewport: { width: 390, height: 844 },
    messages: [userMessage(), assistantMessage([toolPart(id, name, "running", trip)], { completed: false })],
  })

  const result = FlightAction.run(trip)
  await timeline.send(
    partUpdated(toolPart(id, name, "completed", trip, {
      output: result.tool.content,
      metadata: result.tool.metadata,
    })),
  )
  const group = page.getByRole("region", { name: "Flight results" })
  const cards = group.getByRole("article")
  await expect(cards).toHaveCount(2)
  await expect(cards.first()).toContainText("CA 1741")
  await expect(cards.first()).toContainText("杭州 → 成都")
  await expect(cards.first()).toContainText("2026-12-05")
  await expect(cards.first()).toContainText("08:20 → 11:10")
  await expect(cards.first()).toContainText("2h 50m")
  await expect(cards.first()).toContainText("¥560")
  await expect(cards.last()).toContainText("¥620")
  await expect(page.getByText("model-only marker")).toHaveCount(0)
  await expect.poll(() => group.evaluate((node) => node.getBoundingClientRect().right)).toBeLessThanOrEqual(390)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test("keeps an empty result and a failed query separate from an earlier success", async ({ page }) => {
  const earlier = { originCity: "杭州", destinationCity: "成都", dateOfTravel: "2026-12-05" }
  const empty = { ...earlier, dateOfTravel: "2026-12-04" }
  const failed = { ...earlier, dateOfTravel: "2026-12-08" }
  const name = FlightAction.definition.name
  const previous = FlightAction.run(earlier).tool
  const noFlights = FlightAction.run(empty, (input) => FlightAction.simulate(input, "search")).tool

  await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([
      toolPart("prt_previous_flight", name, "completed", earlier, { output: previous.content, metadata: previous.metadata }),
      toolPart("prt_empty_flight", name, "completed", empty, { output: noFlights.content, metadata: noFlights.metadata }),
      toolPart("prt_failed_flight", name, "error", failed, { error: "Flight search failed", metadata: { flightFailure: failed } }),
    ])],
  })

  const previousCard = page.locator('[data-timeline-part-id="prt_previous_flight"]')
  const emptyCard = page.locator('[data-timeline-part-id="prt_empty_flight"]')
  const failure = page.getByRole("region", { name: "Flight search failed" })

  await expect(previousCard.getByRole("article")).toHaveCount(2)
  await expect(previousCard).toContainText("2026-12-05")
  await expect(emptyCard.getByRole("heading", { name: "2026-12-04" })).toBeVisible()
  await expect(emptyCard).toContainText("杭州 → 成都")
  await expect(emptyCard).toContainText("No flights found for this date.")
  await expect(emptyCard.getByRole("article")).toHaveCount(0)
  await expect(failure.getByRole("heading", { name: "2026-12-08" })).toBeVisible()
  await expect(failure).toContainText("杭州 → 成都")
  await expect(failure.getByRole("alert")).toHaveText("Flight search failed")
})
