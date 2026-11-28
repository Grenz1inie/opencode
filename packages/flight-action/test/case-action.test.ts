import { expect, test } from "bun:test"
import { CaseAction, LightningEditor } from "../src/flight-action"

const channel = "lightningDesktopGenAi"
const editorPath = "recipes/lightningTypes/caseInput/lightningDesktopGenAi/editor.json"

test("selects the pinned editor and maps its flat answers to one named case_data input", () => {
  const prepared = CaseAction.prepare({ case_data: { priority: "Medium" } })
  expect(prepared).toMatchObject({
    kind: "registered",
    editor: { channel, definition: "c/caseInputEditor", resource: editorPath },
    fields: [
      { key: "case_data.subject", required: true },
      { key: "case_data.priority", default: "Medium", options: [
        { value: "Low" }, { value: "Medium" }, { value: "High" },
      ] },
      { key: "case_data.description" },
    ],
  })

  const calls: (typeof CaseAction.Input.Type)[] = []
  const target = (input: typeof CaseAction.Input.Type) => {
    calls.push(input)
    return CaseAction.simulate(input)
  }
  const flat = { "case_data.priority": "High", "case_data.description": "  First line\nSecond line  " }

  expect(() => CaseAction.run(CaseAction.fromAnswer(flat), target)).toThrow()
  expect(() => CaseAction.run(CaseAction.fromAnswer({ ...flat, "case_data.subject": "  " }), target)).toThrow()
  expect(() => CaseAction.fromAnswer({ ...flat, "case_data.subject": "Delivery", "case_data.extra": "data" })).toThrow()
  expect(calls).toHaveLength(0)

  CaseAction.run(CaseAction.fromAnswer({ ...flat, "case_data.subject": "  Delivery question  " }), target)
  expect(calls).toEqual([{
    case_data: { subject: "  Delivery question  ", priority: "High", description: "  First line\nSecond line  " },
  }])
})

test("uses default text and date controls without a channel override", () => {
  const resolve = (type: "lightning__textType" | "lightning__dateType") =>
    LightningEditor.resolve(
      { schema: { path: "schema.json", data: { "lightning:type": type } }, editors: {} },
      channel, "value", [],
    )

  expect(resolve("lightning__textType")).toMatchObject({
    kind: "standard", fields: [{ key: "value", type: "string", required: true }],
  })
  expect(resolve("lightning__dateType")).toMatchObject({
    kind: "standard", fields: [{ key: "value", type: "string", required: true, format: "date" }],
  })
})

test("falls back to a closed scalar object and rejects shapes that would lose data", () => {
  const closed = {
    type: "object",
    additionalProperties: false,
    required: ["subject"],
    properties: {
      subject: { "lightning:type": "lightning__textType" },
      followUp: { "lightning:type": "lightning__dateType" },
    },
  }
  const resolve = (data: typeof CaseAction.bundle.schema.data | typeof closed) =>
    LightningEditor.resolve({ ...CaseAction.bundle, schema: { path: "schema.json", data } }, channel, "case_data", [])

  expect(resolve(closed)).toMatchObject({
    kind: "standard", fields: [
      { key: "case_data.subject", required: true },
      { key: "case_data.followUp", required: false, format: "date" },
    ],
  })
  const opaque = resolve(CaseAction.bundle.schema.data)
  expect(opaque).toMatchObject({ kind: "unavailable" })
  if (opaque.kind !== "unavailable") throw new Error("Expected the opaque Apex reference to fail")

  expect(opaque.message).toContain(channel)
  expect(opaque.message).toContain("c/caseInputEditor")
  expect(opaque.message).toContain(editorPath + "#$.editor.componentOverrides.$.definition")
  expect(resolve({ ...closed, additionalProperties: true })).toMatchObject({ kind: "unavailable" })
  expect(LightningEditor.resolve(CaseAction.bundle, "lightningMobileGenAi", "case_data", []))
    .toMatchObject({ kind: "unavailable" })
})
