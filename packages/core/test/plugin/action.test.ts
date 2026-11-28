import { expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Flag } from "@opencode/core/flag"
import { Form } from "@opencode/core/form"
import { Plugin } from "@opencode/core/plugin"
import { Tool } from "@opencode/core/tool"
import type { Catalog, Definition } from "@opencode/plugin/action"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
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
  outputs: {
    receipt: { type: "receipt", is_displayable: true },
    note: { type: "sampleId", is_displayable: true, filter_from_agent: true },
  },
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

const execute = (tools: Tool.Snapshot, input: unknown, name = definition.name) =>
  tools.execute({
    sessionID: Session.ID.make("ses_action"),
    agent: Agent.ID.make("build"),
    messageID: SessionMessage.ID.make("msg_action"),
    call: { type: "tool-call", id: "call_action", name, input },
  })

const openForm = <A, E>(invocation: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const created = yield* Deferred.make<Form.Info>()
    const unsubscribe = yield* bus.listen((event) => {
      if (event.type !== Form.Event.Created.type) return Effect.void
      const { form } = Schema.decodeUnknownSync(Form.Event.Created.data)(event.data)
      return Deferred.succeed(created, form).pipe(Effect.asVoid)
    })
    const fiber = yield* invocation.pipe(Effect.forkChild)
    const form = yield* Deferred.await(created).pipe(Effect.timeout("3 seconds"), Effect.ensuring(unsubscribe))
    return { form, fiber }
  })

it.live("collects only missing or invalid required input and runs the target once on a valid answer", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const forms = yield* Form.Service
    const calls: Schema.JsonObject[] = []
    const schedule = {
      ...definition,
      name: "schedule_inspection",
      inputs: {
        station: { type: "lightning__textType", is_required: true, is_user_input: true },
        visitDate: { type: "lightning__dateType", title: "Visit date", is_required: true, is_user_input: true },
        comment: { type: "lightning__textType", is_user_input: true },
        tenant: { type: "sampleId", is_required: true },
      },
    } satisfies Definition
    yield* plugins.activate([
      extension("standard-action-input", {
        types,
        targets: {
          [schedule.target]: (input) =>
            Effect.sync(() => {
              calls.push(input)
              return { receipt: { sampleID: "inspection", marker: "scheduled" }, note: "ok" }
            }),
        },
        widgets: { [definition.widget]: view },
        actions: [schedule],
      }),
    ])

    const snapshot = yield* tools.snapshot()
    const invoke = (input: unknown) => execute(snapshot, input, schedule.name)
    const advertised = snapshot.definitions.find((tool) => tool.name === schedule.name)
    expect(advertised?.inputSchema).toMatchObject({
      properties: { visitDate: { type: "string" } },
      required: ["tenant"],
    })
    const known = { station: "station 4", tenant: "north" }
    const { form, fiber: partial } = yield* openForm(invoke(known))
    expect(form.fields).toEqual([expect.objectContaining({ key: "visitDate", title: "Visit date", format: "date" })])
    expect(calls).toEqual([])
    const invalid = yield* forms.reply({ id: form.id, answer: { visitDate: "2027-02-29" } }).pipe(Effect.flip)
    expect(invalid.message).toContain("visitDate")
    expect(yield* forms.state(form.id)).toEqual({ status: "pending" })
    expect(calls).toEqual([])
    const answer = { id: form.id, answer: { visitDate: "2028-02-29" } }
    yield* forms.reply(answer)
    expect((yield* forms.reply(answer).pipe(Effect.flip))._tag).toBe("Form.AlreadySettledError")
    yield* Fiber.join(partial)
    expect(calls).toEqual([{ ...known, ...answer.answer }])

    const complete = { ...known, visitDate: "2027-05-12", comment: "before noon" }
    yield* invoke(complete)
    expect(yield* forms.list()).toEqual([])
    expect(calls).toEqual([{ ...known, ...answer.answer }, complete])

    const { form: correction, fiber: wrong } = yield* openForm(invoke({ ...known, visitDate: 42 }))
    expect(correction.fields.map((field) => field.key)).toEqual(["visitDate"])
    expect(calls).toHaveLength(2)
    yield* forms.reply({ id: correction.id, answer: { visitDate: "2027-05-14" } })
    yield* Fiber.join(wrong)
    expect(calls[2]).toEqual({ ...known, visitDate: "2027-05-14" })

    const { form: cancelled, fiber: dismissed } = yield* openForm(
      invoke(known).pipe(Effect.catchDefect((error) => Effect.succeed(error))),
    )
    yield* forms.cancel(cancelled.id)
    expect(yield* Fiber.join(dismissed)).toMatchObject({ message: expect.stringContaining("cancelled") })
    const forbidden = yield* invoke({ station: known.station }).pipe(Effect.flip)
    expect(forbidden.message).toContain("tenant")
    expect(yield* forms.list()).toEqual([])
    expect(calls).toHaveLength(3)
  }),
)

it.live("reuses a named Editor for two Actions and validates the complete nested object before settling", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const forms = yield* Form.Service
    const calls: Array<{ action: string; input: Schema.JsonObject }> = []
    const booking = Schema.Struct({
      facility: Schema.String,
      slot: Schema.Struct({
        date: Schema.String,
        code: Schema.String.check(Schema.isPattern(/^CAL-\d+$/)),
        duration: Schema.Number,
      }),
    }).annotate({ identifier: "CalibrationBooking" })
    const names = ["record_calibration", "review_calibration"] as const
    const actions = names.map((name) => ({
      ...definition,
      name,
      target: "local://" + name,
      inputs: { booking: { type: "calibrationBooking", is_required: true, is_user_input: true } },
    }))
    yield* plugins.activate([
      extension("named-action-input", {
        types: { ...types, calibrationBooking: booking },
        editors: {
          calibrationBooking: {
            lightningDesktopGenAi: {
              definition: "fixture/calibration-editor",
              title: "Calibration details",
              fields: [
                { path: ["facility"], type: "lightning__textType", title: "Facility", required: true },
                { path: ["slot", "date"], type: "lightning__dateType", title: "Calibration date", required: true },
                { path: ["slot", "code"], type: "lightning__textType", title: "Calibration code", required: true },
              ],
            },
            lightningMobile: {
              definition: "fixture/mobile-editor",
              title: "Mobile editor",
              fields: [{ path: ["facility"], type: "lightning__textType", title: "Other facility", required: true }],
            },
          },
        },
        targets: Object.fromEntries(actions.map(({ name, target }) => [
          target,
          (input: Schema.JsonObject) => Effect.sync(() => {
            calls.push({ action: name, input })
            return { receipt: { sampleID: "calibration", marker: name }, note: "ok" }
          }),
        ])),
        widgets: { [definition.widget]: view },
        actions,
      }),
    ])

    const snapshot = yield* tools.snapshot()
    const known = { facility: " North Lab ", slot: { code: "CAL-418", duration: 40 } }
    for (const [index, { name }] of actions.entries()) {
      expect(snapshot.definitions.find((tool) => tool.name === name)?.inputSchema).toMatchObject({
        properties: { booking: { properties: { slot: { required: ["duration"] } } } },
      })
      const { form, fiber } = yield* openForm(execute(snapshot, { booking: known }, name))
      expect(form.title).toBe("Calibration details")
      expect(form.metadata?.editor).toEqual({ channel: "lightningDesktopGenAi", definition: "fixture/calibration-editor" })
      expect(form.fields).toEqual([
        expect.objectContaining({ key: "booking.facility", default: " North Lab " }),
        expect.objectContaining({ key: "booking.slot.date", format: "date" }),
        expect.objectContaining({ key: "booking.slot.code", default: "CAL-418" }),
      ])
      expect(calls).toHaveLength(index)
      const answer = {
        "booking.facility": index ? "South Lab" : " North Lab ",
        "booking.slot.date": "2027-06-06",
        "booking.slot.code": "wrong",
      }
      expect((yield* forms.reply({ id: form.id, answer }).pipe(Effect.flip)).message).toEndWith("booking.slot.code")
      expect(yield* forms.state(form.id)).toEqual({ status: "pending" })
      expect(calls).toHaveLength(index)
      yield* forms.reply({ id: form.id, answer: { ...answer, "booking.slot.code": "CAL-501" } })
      yield* Fiber.join(fiber)
      expect(calls[index]).toEqual({
        action: name,
        input: { booking: {
          facility: answer["booking.facility"],
          slot: { code: "CAL-501", date: "2027-06-06", duration: 40 },
        } },
      })
    }
    const unavailable = yield* execute(snapshot, { booking: { facility: "North Lab" } }, names[0]).pipe(Effect.flip)
    expect(unavailable.message).toEndWith("booking.slot.duration")
    expect(yield* forms.list()).toEqual([])
    expect(calls).toHaveLength(2)
  }),
)

it.live("registers Actions as ordinary scoped tools and restores a shadowed registration on unload", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const calls: Array<{ input: Schema.JsonObject; target: string }> = []
    const target = (marker: string) => (input: Schema.JsonObject) =>
      Effect.sync(() => {
        calls.push({ input, target: marker })
        return { receipt: { sampleID: input.sampleID, marker }, note: "user-only" }
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
        outputSchema: expect.objectContaining({ required: ["receipt"] }),
      }),
    ])
    const invalid = yield* execute(snapshot, { sampleID: 42 }).pipe(Effect.flip)
    expect(invalid.message).toContain("sampleID")
    expect(calls).toEqual([])

    const input = { sampleID: "sample-4" }
    const receipt = { ...input, marker: "backup" }
    const result = yield* execute(snapshot, input)
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ receipt }) }])
    expect(result.output).toEqual({ receipt })
    expect(result.metadata?.actionOutput).toEqual({
      view: { ...view, id: definition.widget },
      outputs: { receipt, note: "user-only" },
    })
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

it.live("keeps a static registered view when all outputs are model-only", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const confirmation = { label: "Sample confirmed", body: { definition: "tile/text", attributes: { text: "Confirmed" } } }

    yield* plugins.activate([
      extension("static-action", {
        types,
        actions: [{
          ...definition,
          name: "confirm_sample",
          outputs: { note: { type: "sampleId" } },
        }],
        targets: { [definition.target]: () => Effect.succeed({ note: "model only" }) },
        widgets: { [definition.widget]: confirmation },
      }),
    ])

    const result = yield* execute(yield* tools.snapshot(), { sampleID: "sample-9" }, "confirm_sample")
    expect(result.output).toEqual({ note: "model only" })
    expect(result.metadata?.actionOutput).toEqual({ outputs: {}, view: { ...confirmation, id: definition.widget } })
  }),
)
