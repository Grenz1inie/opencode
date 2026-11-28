export * as CaseAction from "./case-action.js"

import { Schema } from "effect"
import { ActionOutput } from "./action-output.js"
import { LightningEditor } from "./lightning-editor.js"
import schema from "./resources/recipes/lightningTypes/caseInput/schema.json" with { type: "json" }
import editor from "./resources/recipes/lightningTypes/caseInput/lightningDesktopGenAi/editor.json" with { type: "json" }

const channel = "lightningDesktopGenAi"
const definition = "c/caseInputEditor"
const lightningType = "@apexClassType/c__CaseSubmissionService$CaseInput"
const bundlePath = "recipes/lightningTypes/caseInput"
export const bundle = {
  schema: { path: bundlePath + "/schema.json", data: schema },
  editors: { [channel]: { path: bundlePath + "/" + channel + "/editor.json", data: editor } },
}

export const action = {
  name: "submit_case",
  title: "Submit support case",
  inputs: {
    case_data: { complex_data_type_name: "c__caseInput", is_required: true, is_user_input: true },
  },
  outputs: {
    case_number: { is_displayable: false, filter_from_agent: false },
    case_result: { is_displayable: true, filter_from_agent: false },
  },
} as const

const CaseInput = Schema.Struct({
  subject: LightningEditor.NonblankText,
  priority: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
})
export const Input = Schema.Struct({ case_data: CaseInput })
type Input = typeof Input.Type

export const Draft = Schema.Struct({
  case_data: Schema.optionalKey(Schema.Struct({
    subject: Schema.optionalKey(Schema.String),
    priority: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
  })),
})
type Draft = typeof Draft.Type

const subject = "case_data.subject"
const priority = "case_data.priority"
export const description = "case_data.description"
const choices = ["Low", "Medium", "High"].map((value) => ({ value, label: value }))
const localEditor = {
  channel,
  definition,
  lightningType,
  fields: [
    LightningEditor.standardField(subject, "lightning__textType", "Subject", true),
    { ...LightningEditor.standardField(priority, "lightning__textType", "Priority", false), options: choices },
    LightningEditor.standardField(description, "lightning__textType", "Description", false),
  ],
} as const satisfies LightningEditor.Registration

export const isEditor = Schema.is(Schema.Struct({
  channel: Schema.Literal(channel),
  definition: Schema.Literal(definition),
}))

export function prepare(draft: Draft) {
  const plan = LightningEditor.resolve(bundle, channel, "case_data", [localEditor])
  if (plan.kind !== "registered") return plan

  const selected = choices.find((item) => item.value === draft.case_data?.priority)

  return {
    ...plan,
    fields: [
      { ...localEditor.fields[0], default: draft.case_data?.subject },
      { ...localEditor.fields[1], default: selected?.value },
      { ...localEditor.fields[2], default: draft.case_data?.description },
    ] as const,
  }
}

const parseInput = Schema.decodeUnknownSync(Input, { onExcessProperty: "error" })
type FlatAnswer = Readonly<Record<string, unknown>>

export function fromAnswer(answer: FlatAnswer) {
  return parseInput({
    case_data: {
      subject: answer[subject],
      ...(Object.hasOwn(answer, priority) ? { priority: answer[priority] } : {}),
      ...(Object.hasOwn(answer, description) ? { description: answer[description] } : {}),
    },
  })
}

export function simulate(input: Input) {
  const caseNumber = "DEMO-0001"
  return {
    case_number: caseNumber,
    case_result: {
      caseNumber,
      subject: input.case_data.subject,
      priority: input.case_data.priority || "Medium",
      description: input.case_data.description ?? "",
      status: "Simulated",
    },
  }
}

export function run(input: Input, target = simulate) {
  const result = target(parseInput(input))
  return ActionOutput.result(ActionOutput.project(action.outputs, result))
}
