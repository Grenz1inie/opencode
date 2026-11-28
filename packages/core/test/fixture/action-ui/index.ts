import { Plugin } from "@opencode/plugin/effect"
import type { Catalog, Target } from "@opencode/plugin/action"
import { Effect, Schema } from "effect"

const Options = Schema.Struct({
  action: Schema.optionalKey(Schema.String),
  target: Schema.optionalKey(Schema.String),
  instrumentType: Schema.optionalKey(Schema.String),
})

function target(location: string, name: string, marker: string): Target {
  return (input) =>
    Effect.logInfo("Calibration fixture target called", { location, name, input }).pipe(
      Effect.as({
        record: {
          instrument: input.instrument,
          lab: input.lab,
          status: "Calibration complete",
          marker,
        },
      }),
    )
}

export default Plugin.define({
  id: "fixture.calibration",
  effect: Effect.fn("CalibrationFixture")(function* (context) {
    const options = Schema.decodeUnknownSync(Options)(context.options)
    const location = context.location.directory
    const resultView = "fixture/calibration-result"
    yield* context.experimental.action.register({
      actions: [
        {
          name: options.action ?? "inspect_calibration",
          description: "Look up the calibration record for a known instrument and lab.",
          target: options.target ?? "local://primary",
          inputs: {
            instrument: { type: options.instrumentType ?? "instrumentID", is_required: true },
            lab: { type: "labName", is_required: true },
          },
          outputs: { record: { type: "calibrationRecord", is_displayable: true } },
          widget: resultView,
        },
      ],
      types: {
        instrumentID: Schema.NonEmptyString.annotate({ description: "The instrument identifier supplied by the user." }),
        labName: Schema.NonEmptyString.annotate({ description: "The lab name supplied by the user." }),
        calibrationRecord: Schema.Struct({
          instrument: Schema.String,
          lab: Schema.String,
          status: Schema.String,
          marker: Schema.String,
        }),
      },
      targets: {
        "local://primary": target(location, "A", "PRIMARY-A"),
        "local://backup": target(location, "B", "BACKUP-B"),
      },
      widgets: {
        [resultView]: {
          label: "Calibration result",
          body: {
            definition: "tile/widget",
            children: [
              {
                definition: "tile/text",
                attributes: { text: "Calibration record", variant: "h2" },
              },
              {
                definition: "tile/column",
                attributes: { gap: "sm" },
                children: [
                  { definition: "tile/text", attributes: { text: "{!$attrs.record.instrument} · {!$attrs.record.lab}", variant: "h4" } },
                  { definition: "tile/text", attributes: { text: "{!$attrs.record.status}" } },
                  { definition: "tile/text", attributes: { text: "Source {!$attrs.record.marker}", color: "muted" } },
                ],
              },
            ],
          },
        },
      },
    } satisfies Catalog)
  }),
})
