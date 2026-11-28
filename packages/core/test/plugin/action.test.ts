import { expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Flag } from "@opencode/core/flag"
import { Plugin } from "@opencode/core/plugin"
import { Tool } from "@opencode/core/tool"
import type { Catalog, Definition } from "@opencode/plugin/action"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer.pipe(Layer.provide(Layer.succeed(Flag.Overrides, "action_ui"))))

const view = {
  label: "Sample receipt",
  body: {
    definition: "tile/widget",
    children: [{ definition: "tile/text", attributes: { text: "{!$attrs.receipt.marker}" } }],
  },
}

const definition = {
  name: "inspect_sample",
  description: "Inspect the supplied sample ID.",
  target: "local://primary",
  widget: "sample/receipt",
  inputs: { sampleID: { type: "sampleId", is_required: true } },
  outputs: { receipt: { type: "receipt", is_displayable: true } },
} satisfies Definition

const types = {
  sampleId: Schema.NonEmptyString,
  receipt: Schema.Struct({ sampleID: Schema.String, marker: Schema.String }),
}

function extension(id: string, catalog: Catalog): Plugin.Generation {
  return {
    id,
    revision: "1",
    effect: (context) => context.experimental.action.register(catalog).pipe(Effect.asVoid),
  }
}

const execute = (tools: Tool.Snapshot, input: unknown) =>
  tools.execute({
    sessionID: Session.ID.make("ses_action"),
    agent: Agent.ID.make("build"),
    messageID: SessionMessage.ID.make("msg_action"),
    call: { type: "tool-call", id: "call_action", name: definition.name, input },
  })

it.live("registers Actions as ordinary scoped tools and restores a shadowed registration on unload", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const calls: Array<{ input: Schema.JsonObject; target: string }> = []
    const target = (marker: string) => (input: Schema.JsonObject) =>
      Effect.sync(() => {
        calls.push({ input, target: marker })
        return { receipt: { sampleID: input.sampleID, marker } }
      })
    const catalog = {
      types,
      targets: { "local://primary": target("primary"), "local://backup": target("backup") },
      widgets: { [definition.widget]: view },
      actions: [definition],
    } satisfies Catalog
    const first = extension("first-test-action", catalog)
    const override = extension("second-test-action", {
      ...catalog,
      actions: [{ ...definition, target: "local://backup" }],
    })

    expect((yield* tools.snapshot()).definitions.some((tool) => tool.name === definition.name)).toBe(false)
    yield* plugins.activate([first, override])
    const snapshot = yield* tools.snapshot()
    expect(snapshot.definitions.filter((tool) => tool.name === definition.name)).toEqual([
      expect.objectContaining({
        name: definition.name,
        description: definition.description,
        inputSchema: expect.objectContaining({
          properties: { sampleID: expect.objectContaining({ type: "string" }) },
          required: ["sampleID"],
        }),
      }),
    ])
    const invalid = yield* execute(snapshot, { sampleID: 42 }).pipe(Effect.flip)
    expect(invalid.message).toContain("sampleID")
    expect(calls).toEqual([])

    const input = { sampleID: "sample-4" }
    const receipt = { ...input, marker: "backup" }
    const result = yield* execute(snapshot, input)
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ receipt }) }])
    expect(result.metadata?.actionOutput).toEqual({ widget: definition.widget, view, outputs: { receipt } })
    expect(calls).toEqual([{ input, target: "backup" }])

    yield* plugins.activate([first])
    yield* execute(yield* tools.snapshot(), input)
    expect(calls).toEqual([{ input, target: "backup" }, { input, target: "primary" }])

    yield* plugins.activate([])
    expect((yield* tools.snapshot()).definitions.some((tool) => tool.name === definition.name)).toBe(false)
  }),
)

it.live("skips Actions with unresolved references and rejects invalid results from a registered target", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const received: Schema.JsonObject[] = []

    yield* plugins.activate([
      extension("invalid-action-catalog", {
        types,
        targets: {
          [definition.target]: (input) =>
            Effect.sync(() => {
              received.push(input)
              return { receipt: { marker: 123 }, undeclared: "SECRET" }
            }),
        },
        widgets: { [definition.widget]: view },
        actions: [
          { ...definition, name: "missing_target", target: "local://unknown" },
          { ...definition, name: "missing_type", inputs: { sampleID: { type: "unknown" } } },
          { ...definition, name: "missing_widget", widget: "sample/unknown" },
          definition,
        ],
      }),
    ])

    const snapshot = yield* tools.snapshot()
    expect(snapshot.definitions.map((tool) => tool.name)).toContain(definition.name)
    expect(snapshot.definitions.filter((tool) => tool.name.startsWith("missing_"))).toEqual([])
    expect(received).toEqual([])
    const input = { sampleID: "sample-8" }
    const error = yield* execute(snapshot, input).pipe(Effect.flip)
    expect(error.message).toBe('Action "inspect_sample" returned invalid outputs')
    expect(error.metadata?.actionOutput).toBeUndefined()
    expect(received).toEqual([input])
  }),
)
