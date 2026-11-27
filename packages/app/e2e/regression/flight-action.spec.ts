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
      output: "model-only marker",
      metadata: { flightAction: result.user ?? null },
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
