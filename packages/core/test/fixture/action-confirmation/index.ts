import type { ActionContext, Catalog, Definition, Target } from "@opencode/plugin/action"
import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema } from "effect"

const SessionState = Schema.Struct({ ready: Schema.Boolean, lab: Schema.NonEmptyString })
const readState = Schema.decodeUnknownEffect(SessionState)
const widget = "fixture/calibration-publication"

function target(operation: string): Target {
  return (input, context) =>
    Effect.logInfo("Calibration publication fixture ran", {
      operation,
      sessionID: context.sessionID,
      call: context.id,
      input: JSON.stringify(input),
    }).pipe(Effect.as({ receipt: { operation, reportID: input.reportID, lab: input.lab } }))
}

export default Plugin.define({
  id: "fixture.calibration-publication",
  effect: Effect.fn("CalibrationPublicationFixture")(function* (context) {
    const state = (request: ActionContext) =>
      context.session.get({ sessionID: request.sessionID }).pipe(
        Effect.flatMap((session) => readState(session.metadata?.calibration)),
        Effect.orElseSucceed(() => undefined),
      )
    const read = {
      name: "inspect_calibration_report",
      description: "Inspect a reviewed calibration report by its report ID.",
      available: (request) => state(request).pipe(Effect.map((current) => current?.ready === true)),
      target: "local://inspect-calibration",
      widget,
      inputs: {
        reportID: { type: "lightning__textType", title: "Report ID", is_required: true, is_user_input: true },
        lab: {
          type: "lab",
          is_required: true,
          bind: (request) => state(request).pipe(Effect.map((current) => current?.lab)),
        },
      },
      outputs: { receipt: { type: "receipt", is_displayable: true } },
    } satisfies Definition
    const publish = {
      ...read,
      name: "publish_calibration_report",
      description: "Publish the reviewed calibration report with the given report ID.",
      target: "local://publish-calibration",
      confirmation: {
        title: "Confirm report publication",
        message: "Publish the reviewed calibration report for the lab linked to this session?",
      },
    } satisfies Definition

    yield* context.experimental.action.register({
      actions: [read, publish],
      types: {
        lab: Schema.NonEmptyString,
        receipt: Schema.Struct({ operation: Schema.String, reportID: Schema.String, lab: Schema.String }),
      },
      targets: {
        [read.target]: target("inspected"),
        [publish.target]: target("published"),
      },
      widgets: {
        [widget]: {
          label: "Calibration report receipt",
          body: {
            definition: "tile/widget",
            children: [
              { definition: "tile/text", attributes: { text: "Calibration report receipt", variant: "h2" } },
              {
                definition: "tile/text",
                attributes: { text: "{!$attrs.receipt.operation} {!$attrs.receipt.reportID} · {!$attrs.receipt.lab}" },
              },
            ],
          },
        },
      },
    } satisfies Catalog)
  }),
})
