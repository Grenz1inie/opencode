import { expect, test } from "bun:test"
import { ActionOutput } from "../src/action-output.js"

test("projects entire declared outputs independently, with model-only defaults", () => {
  const both = { city: "BOTH_4A" }
  const visible = { details: ["USER_4B"] }
  const model = { details: { label: "MODEL_4C" } }
  const projections = ActionOutput.project(
    {
      both: { is_displayable: true, filter_from_agent: false },
      visible: { is_displayable: true, filter_from_agent: true },
      model: { is_displayable: false, filter_from_agent: false },
      neither: { is_displayable: false, filter_from_agent: true },
      defaulted: {},
    },
    { both, visible, model, neither: "NEITHER_4D", defaulted: "DEFAULT_4E", unknown: "UNDECLARED_4F" },
  )
  expect(projections.user).toEqual({ both, visible })
  expect(projections.model).toEqual({ both, model, defaulted: "DEFAULT_4E" })
  const result = ActionOutput.result(projections, "flight")
  expect(JSON.parse(result.content)).toEqual(projections.model)
  expect(result.metadata.actionOutput).toEqual({ outputs: projections.user, widget: "flight" })
})

test("keeps model values out of the metadata when nothing is displayable", () => {
  const result = ActionOutput.result(ActionOutput.project({ note: {} }, { note: "MODEL_ONLY" }), "flight")
  expect(result.metadata.actionOutput).toEqual({ outputs: {} })
  expect(JSON.parse(result.content)).toEqual({ note: "MODEL_ONLY" })
})
