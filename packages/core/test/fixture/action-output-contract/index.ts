import type { Catalog, Definition, Target } from "@opencode/plugin/action"
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Effect, Schema } from "effect"

const renderer = "archive/batch"
const widget = "archive/summary"
const invalidWidget = "archive/bad-title"

const inspect = {
  name: "inspect_archive_batch",
  description: "Inspect a test archive batch by its scenario name.",
  target: "local://inspect-archive-batch",
  renderer,
  inputs: { batch: { type: "lightning__textType", is_required: true } },
  outputs: {
    shared: { type: "entries", is_displayable: true, filter_from_agent: false },
    forUser: { type: "entries", is_displayable: true, filter_from_agent: true },
    forModel: { type: "marker", is_displayable: false, filter_from_agent: false },
    neither: { type: "marker", is_displayable: false, filter_from_agent: true },
  },
} satisfies Definition

const target: Target = (input, context) =>
  Effect.gen(function* () {
    const batch = String(input.batch).toUpperCase()
    yield* Effect.logInfo("Archive output fixture ran", { batch, call: context.id })
    const outputs = {
      shared: batch === "EMPTY" ? [] : [{ marker: "ARCHIVE_SHARED_" + batch }],
      forUser: batch === "EMPTY" ? [] : [{ marker: "ARCHIVE_USER_" + batch }],
      forModel: "ARCHIVE_MODEL_" + batch,
      neither: "ARCHIVE_NEITHER_" + batch,
    }
    if (batch === "EXECUTION") {
      yield* context.progress({
        output: outputs.forModel,
        actionOutput: { outputs },
        actionDiagnostic: { stage: "widget", path: outputs.forModel },
      })
      return yield* new Tool.Error({ message: outputs.forModel, metadata: { actionOutput: { outputs } } })
    }
    if (batch === "STRUCTURE") return { ...outputs, shared: [{ marker: { invalid: outputs.forModel } }] }
    return outputs
  })

export default Plugin.define({
  id: "fixture.archive-output-contract",
  effect: (context) =>
    context.experimental.action.register({
      actions: [
        inspect,
        { ...inspect, name: "inspect_archive_missing_renderer", renderer: "archive/missing-renderer" },
        { ...inspect, name: "inspect_archive_missing_widget", renderer: "archive/broken-widget-ref" },
        { ...inspect, name: "inspect_archive_bad_title", renderer: "archive/malformed", widget: invalidWidget },
        { ...inspect, name: "inspect_archive_unknown_type", outputs: { shared: { type: "archive/unregistered" } } },
      ],
      types: {
        entries: Schema.Array(Schema.Struct({ marker: Schema.String })),
        marker: Schema.String,
      },
      targets: { [inspect.target]: target },
      renderers: {
        [renderer]: { type: "entries", widget },
        "archive/broken-widget-ref": { type: "entries", widget: "archive/missing-widget" },
        "archive/malformed": { type: "entries", widget: invalidWidget },
      },
      widgets: {
        [widget]: {
          label: "Archive batch results",
          body: {
            definition: "tile/widget",
            children: [
              { definition: "tile/text", attributes: { text: "Archive batch", variant: "h2" } },
              {
                definition: "tile/text",
                meta: { forEach: "{!$attrs.shared}" },
                attributes: { text: "{!$Item.marker}" },
              },
              {
                definition: "tile/text",
                meta: { forEach: "{!$attrs.forUser}" },
                attributes: { text: "{!$Item.marker}" },
              },
            ],
          },
        },
        [invalidWidget]: {
          label: "Archive batch results",
          body: {
            definition: "tile/widget",
            children: [{ definition: "tile/text", attributes: { text: 29, variant: "h2" } }],
          },
        },
      },
    } satisfies Catalog).pipe(Effect.asVoid),
})
