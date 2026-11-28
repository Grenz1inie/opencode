import { expect, test } from "@playwright/test"
import { ActionOutput, CustomerReviews, FlightAction } from "@opencode/flight-action"
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

test("renders original Pronto reviews and shows diagnostics for invalid direct outputs", async ({ page }) => {
  const reviews = CustomerReviews.sample(false)

  const invalid = (outputs: Parameters<typeof ActionOutput.result>[0]["user"]) =>
    ActionOutput.result({ user: outputs, model: {} }, CustomerReviews.widget)

  const part = (key: string, output: ReturnType<typeof CustomerReviews.run>) =>
    toolPart("prt_reviews_" + key, CustomerReviews.name, "completed", {}, {
      output: output.content,
      metadata: output.metadata,
    })

  await setupTimeline(page, {
    viewport: { width: 390, height: 844 },
    messages: [
      userMessage(),
      assistantMessage([
        part("sample", CustomerReviews.run({})),
        part("empty", CustomerReviews.run({ empty: true })),
        part("missing", invalid({ reviews: { reviewCount: reviews.reviewCount, averageRating: reviews.averageRating } })),
        part(
          "wrong_type",
          invalid({
            reviews: { ...reviews, items: [{ ...reviews.items[0], rating: "REJECTED_RATING" }] },
            notice: "VALID_REVIEW_NOTICE",
          }),
        ),
      ]),
    ],
  })

  const output = (key: string) => page.locator(`[data-timeline-part-id="prt_reviews_${key}"]`)
  const sample = output("sample").getByRole("region", { name: "Customer reviews" })
  await expect(sample.getByRole("heading", { name: "Customer Reviews", exact: true })).toBeVisible()
  await expect(sample).toContainText("Average: 4.5/5 (2 reviews)")
  const rows = sample.getByRole("article")
  await expect(rows).toHaveCount(2)

  for (const [index, item] of reviews.items.entries()) {
    const row = rows.nth(index)
    await expect(row.getByRole("heading", { name: item.customerName })).toBeVisible()
    await expect(row.getByRole("img", { name: "Rating" })).toBeVisible()

    for (const text of [item.orderDate, `${item.rating}/5`, item.comments]) {
      await expect(row.getByText(text, { exact: true })).toBeVisible()
    }
  }

  const empty = output("empty").getByRole("region", { name: "Customer reviews" })
  await expect(empty.getByRole("heading", { name: "Customer Reviews", exact: true })).toBeVisible()
  await expect(empty).toContainText("Average: 0/5 (0 reviews)")
  await expect(empty.getByRole("article")).toHaveCount(0)
  await expect(output("missing")).toContainText(CustomerReviews.widget + " · $.outputs.reviews.items")
  await expect(output("missing").locator("pre")).toHaveCount(0)

  const badRating = output("wrong_type")
  await expect(badRating).toContainText(CustomerReviews.widget + " · $.outputs.reviews.items.0.rating")
  await expect(badRating.locator("pre")).toContainText("VALID_REVIEW_NOTICE")
  await expect(badRating).not.toContainText("REJECTED_RATING")
})

test("keeps a valid empty Pronto MCP card distinct from failed Invocable results", async ({ page }) => {
  const mcpTool = "pronto_getCustomerReviews"
  const success = CustomerReviews.run({ empty: true })

  const failure = (id: string, stage: ActionOutput.Diagnostic["stage"], path: string) =>
    toolPart(id, mcpTool, "error", {}, {
      error: "Private server response",
      metadata: { actionDiagnostic: { stage, path }, actionOutput: { outputs: {} } },
    })

  await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([
      toolPart("prt_reviews_mcp_empty", mcpTool, "completed", {}, { output: success.content, metadata: success.metadata }),
      failure("prt_reviews_mcp_failed", "actionResult", "$.structuredContent.outputValues.isSuccess"),
      failure("prt_reviews_mcp_invalid", "actionSchema", "$.structuredContent.outputValues.reviews"),
    ])],
  })

  const card = page.getByRole("region", { name: "Customer reviews" })
  await expect(card).toHaveCount(1)
  await expect(card.getByRole("heading", { name: "Customer Reviews" })).toBeVisible()
  await expect(card).toContainText("Average: 0/5 (0 reviews)")
  await expect(card.getByRole("article")).toHaveCount(0)
  await expect(page.getByRole("alert").filter({ hasText: "The Action reported a failure" }))
    .toContainText("$.structuredContent.outputValues.isSuccess")
  await expect(page.getByRole("alert").filter({ hasText: "did not match the Action output contract" }))
    .toContainText("$.structuredContent.outputValues.reviews")
  await expect(page.getByText("Private server response")).toHaveCount(0)
})

test("renders an extension's declarative Action result using existing tiles", async ({ page }) => {
  const output = {
    outputs: { receipt: { reference: "SAMPLE-22" } },
    view: {
      id: "sample/result",
      label: "Sample result",
      body: {
        definition: "tile/widget",
        children: [{ definition: "tile/text", attributes: { text: "Sample {!$attrs.receipt.reference}", variant: "h2" } }],
      },
    },
  }

  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart("prt_extension_action", "read_sample_reference", "completed", {}, {
          output: "MODEL_ONLY_FIXTURE",
          metadata: { actionOutput: output },
        }),
      ]),
    ],
  })
  const card = page.getByRole("region", { name: "Sample result", exact: true })
  await expect(card).toHaveCount(1)
  await expect(card.getByRole("heading", { name: "Sample SAMPLE-22", exact: true })).toBeVisible()
  await expect(page.getByText("MODEL_ONLY_FIXTURE")).toHaveCount(0)
})

test("keeps an extension Action's empty result, rendered fallback, and execution failure distinct on replay", async ({
  page,
}) => {
  const name = "inspect_archive_batch"
  const hidden = "MODEL_ONLY_ARCHIVE"

  const part = (key: string) => page.locator(`[data-timeline-part-id="prt_archive_${key}"]`)
  const view = {
    id: "archive/detail",
    label: "Archive detail",
    body: { definition: "tile/text", attributes: { text: 42 } },
  }

  await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([
      toolPart("prt_archive_empty", name, "completed", {}, {
        metadata: { actionOutput: { outputs: { entries: [], total: 0 } } },
      }),
      toolPart("prt_archive_fallback", name, "completed", {}, {
        output: hidden,
        metadata: { actionOutput: { outputs: { entries: ["ARCHIVE_FALLBACK"] }, view } },
      }),
      toolPart("prt_archive_renderer", name, "completed", {}, {
        output: hidden,
        metadata: {
          actionOutput: { outputs: { entries: ["ARCHIVE_RENDERER"] } },
          actionDiagnostic: { stage: "renderer", path: "renderers.archive/missing" },
        },
      }),
      toolPart("prt_archive_failure", name, "error", {}, {
        error: hidden,
        metadata: { actionDiagnostic: { stage: "actionResult", path: "target" } },
      }),
    ])],
  })

  async function assertResults() {
    await expect(part("empty").getByRole("status")).toHaveText("No list items")
    await expect(part("fallback").getByRole("status"))
      .toHaveText("Widget output could not be displayed (archive/detail · $.attributes.text).")
    await expect(part("fallback").locator("pre")).toHaveText(JSON.stringify({ entries: ["ARCHIVE_FALLBACK"] }, null, 2))
    await expect(part("renderer").getByRole("status"))
      .toHaveText("The Action renderer could not be loaded (renderers.archive/missing).")
    await expect(part("renderer").locator("pre")).toHaveText(JSON.stringify({ entries: ["ARCHIVE_RENDERER"] }, null, 2))
    await expect(part("failure").getByRole("alert")).toHaveText("The Action reported a failure (target).")
    await expect(part("failure").locator("pre")).toHaveCount(0)
    await expect(page.getByText(hidden, { exact: false })).toHaveCount(0)
  }

  await assertResults()
  await page.reload()
  await assertResults()
})
