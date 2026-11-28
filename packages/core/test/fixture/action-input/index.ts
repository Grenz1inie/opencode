import { Plugin } from "@opencode/plugin/effect"
import type { Catalog, Definition, Editor, Target } from "@opencode/plugin/action"
import { Effect, Schema } from "effect"

const widget = "fixture/calibration-input-receipt"
export const bookingEditor = {
  definition: "fixture/calibration-booking-editor",
  title: "Calibration booking",
  fields: [
    { path: ["facility"], type: "lightning__textType", title: "Facility", required: true },
    { path: ["memo"], type: "lightning__textType", title: "Memo" },
    { path: ["slot", "visitDate"], type: "lightning__dateType", title: "Calibration date", required: true },
    { path: ["slot", "code"], type: "lightning__textType", title: "Calibration code", required: true },
  ],
} satisfies Editor

const calendarDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)).check(
  Schema.makeFilter(
    (value) => {
      const date = new Date(value + "T00:00:00Z")
      return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value + "T")
    },
    { expected: "a calendar date" },
  ),
)

export const bookingType = Schema.Struct({
  facility: Schema.String,
  memo: Schema.optionalKey(Schema.String),
  slot: Schema.Struct({
    visitDate: calendarDate,
    code: Schema.String.check(Schema.isPattern(/^CAL-\d+$/)),
    duration: Schema.Number,
  }),
}).annotate({ identifier: "CalibrationBooking" })

function action(name: string, description: string, inputs: Definition["inputs"]): Definition {
  return {
    name,
    description,
    target: "local://" + name,
    inputs,
    outputs: { receipt: { type: "calibrationReceipt", is_displayable: true } },
    widget,
  }
}

const compound = { booking: { type: "calibrationBooking", is_required: true, is_user_input: true } }
const actions = [
  action("schedule_calibration", "Schedule a calibration for the named instrument and site.", {
    instrument: { type: "lightning__textType", title: "Instrument", is_required: true, is_user_input: true },
    visitDate: { type: "lightning__dateType", title: "Calibration date", is_required: true, is_user_input: true },
    site: { type: "site", title: "Approved site", is_required: true, is_user_input: false },
    note: { type: "lightning__textType", title: "Note", is_user_input: true },
  }),
  action("record_calibration", "Record a calibration with the supplied booking details.", compound),
  action("review_calibration", "Review the supplied calibration booking details.", compound),
]

function target(name: string): Target {
  return (input, context) =>
    Effect.logInfo("Calibration input fixture target called", {
      name,
      call: context.id,
      input: JSON.stringify(input),
    }).pipe(Effect.as({ receipt: { action: name, input } }))
}

export default Plugin.define({
  id: "fixture.calibration-input",
  effect: Effect.fn("CalibrationInputFixture")(function* (context) {
    yield* context.experimental.action.register({
      actions,
      editors: {
        calibrationBooking: {
          lightningDesktopGenAi: bookingEditor,
          lightningMobile: {
            ...bookingEditor,
            definition: "fixture/mobile-booking-editor",
            title: "Mobile calibration booking",
          },
        },
      },
      types: {
        site: Schema.NonEmptyString,
        calibrationBooking: bookingType,
        calibrationReceipt: Schema.Struct({ action: Schema.String, input: Schema.JsonObject }),
      },
      targets: Object.fromEntries(actions.map(({ name, target: ref }) => [ref, target(name)])),
      widgets: {
        [widget]: {
          label: "Calibration receipt",
          body: {
            definition: "tile/widget",
            children: [
              { definition: "tile/text", attributes: { text: "Calibration input accepted", variant: "h2" } },
              { definition: "tile/text", attributes: { text: "{!$attrs.receipt.action}" } },
            ],
          },
        },
      },
    } satisfies Catalog)
  }),
})
