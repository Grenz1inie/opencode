import { expect, test } from "@playwright/test"
import { ActionOutput, FlightAction } from "@opencode/flight-action"
import { assistantMessage, setupTimeline, toolPart, userMessage } from "../utils/timeline"

test("limits Action details, invalid Widget fallback, and replay to the user projection", async ({ page }) => {
  const name = FlightAction.definition.name
  const trip = { originCity: "杭州", destinationCity: "成都", dateOfTravel: "2026-12-05" }
  const results = { ...FlightAction.simulate(trip), originCity: "BOTH_4A" }

  const policies = {
    results: { is_displayable: true, filter_from_agent: false },
    notice: { is_displayable: true, filter_from_agent: true },
    model: { is_displayable: false, filter_from_agent: false },
    hidden: { is_displayable: false, filter_from_agent: true },
    defaulted: {},
  }

  const values = {
    results,
    notice: { detail: "USER_4B" },
    model: { detail: "MODEL_4C" },
    hidden: "NEITHER_4D",
    defaulted: "DEFAULT_4E",
  }

  const good = ActionOutput.result(ActionOutput.project(policies, values), FlightAction.widget)

  const broken = ActionOutput.result(
    ActionOutput.project(policies, { notice: values.notice, model: values.model }),
    FlightAction.widget,
  )

  const invalid = ActionOutput.result(
    ActionOutput.project(policies, {
      ...values,
      results: { ...results, flights: [{ ...results.flights[0], fare: "REJECTED_4H" }] },
    }),
    FlightAction.widget,
  )

  const empty = ActionOutput.result(ActionOutput.project({ model: {} }, { model: "EMPTY_MODEL_4F" }), FlightAction.widget)

  const part = (id: string, output: typeof good) =>
    toolPart(id, name, "completed", trip, { output: output.content, metadata: output.metadata })

  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        part("prt_visibility", good),
        part("prt_broken_widget", broken),
        part("prt_rejected_output", invalid),
        part("prt_empty_ui", empty),
        toolPart("prt_failed_action", name, "error", trip, { error: "RAW_FAILURE_4G" }),
      ]),
    ],
  })
  const healthy = page.locator('[data-timeline-part-id="prt_visibility"]')
  const fallback = page.locator('[data-timeline-part-id="prt_broken_widget"]')

  const assertHidden = async () => {
    for (const marker of ["MODEL_4C", "NEITHER_4D", "DEFAULT_4E", "EMPTY_MODEL_4F", "RAW_FAILURE_4G", "REJECTED_4H"]) {
      await expect(page.getByText(marker, { exact: false })).toHaveCount(0)
    }
  }

  await expect(healthy.getByRole("region", { name: "Flight results" })).toContainText("BOTH_4A")
  await healthy.getByText("Output details", { exact: true }).click()
  await expect(healthy.locator("pre")).toBeVisible()
  await expect(healthy.locator("pre")).toContainText("USER_4B")
  await expect(fallback).toContainText(FlightAction.widget + " · $.outputs.results")
  await expect(fallback.locator("pre")).toContainText("USER_4B")
  const rejected = page.locator('[data-timeline-part-id="prt_rejected_output"]')
  await expect(rejected).toContainText(FlightAction.widget + " · $.outputs.results.flights.0.fare")
  await expect(rejected.locator("pre")).toContainText("USER_4B")
  await expect(rejected.locator("pre")).not.toContainText("REJECTED_4H")
  await expect(page.locator('[data-timeline-part-id="prt_empty_ui"]')).toHaveText("Action completed")
  await expect(page.locator('[data-timeline-part-id="prt_failed_action"]')).toHaveText("Action failed or was cancelled")
  await assertHidden()

  await page.reload()
  await expect(healthy.getByRole("region", { name: "Flight results" })).toContainText("BOTH_4A")
  await healthy.getByText("Output details", { exact: true }).click()
  await expect(healthy.locator("pre")).toContainText("USER_4B")
  await assertHidden()
})
