import { expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Flag } from "@opencode/core/flag"
import { Form } from "@opencode/core/form"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Tool } from "@opencode/core/tool"
import type { Catalog, Definition } from "@opencode/plugin/action"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { bookingEditor, bookingType } from "../fixture/action-input"
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
    const finished = Fiber.join(fiber).pipe(Effect.andThen(Effect.die("Action completed without opening a form")))
    const form = yield* Effect.raceFirst(Deferred.await(created), finished).pipe(Effect.ensuring(unsubscribe))
    return { form, fiber }
  })

it.live("advertises an Action only for an eligible session and rechecks captured calls against current policy", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const sessionID = Session.ID.make("ses_action")
    const agent = Agent.ID.make("build")
    const host = yield* PluginHost.make(plugins, "setup-action-session")
    yield* host.session.create({ id: sessionID, metadata: { workspace: "lab:ses_action" } })
    const eligible = new Set([sessionID])
    const received: Schema.JsonObject[] = []
    const action = {
      ...definition,
      available: ({ sessionID }) => Effect.sync(() => eligible.has(sessionID)),
      inputs: {
        ...definition.inputs,
        workspace: {
          type: "sampleId",
          is_required: true,
          is_user_input: true,
          bind: ({ sessionMetadata }) =>
            Effect.succeed(typeof sessionMetadata?.workspace === "string" ? sessionMetadata.workspace : undefined),
        },
      },
    } satisfies Definition

    yield* plugins.activate([
      extension("session-action", {
        actions: [action],
        types,
        widgets: { [definition.widget]: view },
        targets: {
          [action.target]: (input) => Effect.sync(() => {
            received.push(input)
            return { receipt: { sampleID: input.sampleID, marker: "ok" }, note: "ok" }
          }),
        },
      }),
    ])

    const request = { context: { sessionID, agent } }
    const active = yield* tools.snapshot(undefined, request)
    expect(active.definitions.find((entry) => entry.name === action.name)?.inputSchema).toMatchObject({
      properties: { sampleID: { type: "string" } },
      required: ["sampleID"],
    })
    expect(active.definitions.find((entry) => entry.name === action.name)?.inputSchema.properties).not.toHaveProperty("workspace")
    const other = yield* tools.snapshot(undefined, { context: { agent, sessionID: Session.ID.make("ses_other") } })
    expect(other.definitions.map((entry) => entry.name)).not.toContain(action.name)
    yield* execute(active, { sampleID: "CAL-28", workspace: "model-supplied" })
    expect(received).toEqual([{ sampleID: "CAL-28", workspace: "lab:ses_action" }])

    eligible.delete(sessionID)
    const next = yield* tools.snapshot(undefined, request)
    expect(next.definitions.map((entry) => entry.name)).not.toContain(action.name)
    const stale = yield* execute(active, { sampleID: "CAL-29" }).pipe(Effect.flip)
    expect(stale.message).toContain("not currently available")
    expect(received).toHaveLength(1)
  }),
)

it.live("never substitutes model input for an absent optional binding", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const host = yield* PluginHost.make(plugins, "setup-action-session")
    yield* host.session.create({ id: Session.ID.make("ses_action") })
    const received: Schema.JsonObject[] = []
    const action = {
      name: "bound_only",
      description: "Inspect the bound workspace if present.",
      target: "local://bound-only",
      inputs: { workspace: { type: "sampleId", bind: () => Effect.undefined } },
      outputs: {},
    } satisfies Definition
    yield* plugins.activate([
      extension("bound-only", {
        actions: [action],
        types,
        targets: {
          [action.target]: (input) => Effect.sync(() => {
            received.push(input)
            return {}
          }),
        },
      }),
    ])
    yield* execute(yield* tools.snapshot(), { workspace: "model-supplied" }, action.name)
    expect(received).toEqual([{}])
  }),
)

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
        duration: { type: "lightning__numberType", is_required: true, is_user_input: true },
        attempts: { type: "lightning__integerType", is_required: true, is_user_input: true },
        confirmed: { type: "lightning__booleanType", is_required: true, is_user_input: true },
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
    const known = { station: "station 4", tenant: "north", duration: 1.5, attempts: 2, confirmed: false }
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
    const badOptional = yield* invoke({ ...known, comment: 42 }).pipe(Effect.flip)
    expect(badOptional.message).toEndWith("comment")
    expect(yield* forms.list()).toEqual([])
    expect(calls).toHaveLength(3)

    const { form: numeric, fiber: typed } = yield* openForm(invoke({
      station: "station 4", tenant: "north", visitDate: "2027-05-14",
    }))
    expect(numeric.fields.map(({ type }) => type)).toEqual(["number", "integer", "boolean"])
    const values = { duration: 2.5, attempts: 3, confirmed: false }
    yield* forms.reply({ id: numeric.id, answer: values })
    yield* Fiber.join(typed)
    expect(calls[3]).toEqual({ ...known, ...values, visitDate: "2027-05-14" })
  }),
)

it.live("waits for explicit business confirmation, and rechecks availability after the user decides", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const forms = yield* Form.Service
    const received: Schema.JsonObject[] = []
    const host = yield* PluginHost.make(plugins, "setup-action-session")
    yield* host.session.create({ id: Session.ID.make("ses_action") })
    let available = true
    const action = {
      ...definition,
      available: () => Effect.sync(() => available),
      confirmation: { title: "Confirm publication", message: "Publish the reviewed calibration report." },
    } satisfies Definition
    yield* plugins.activate([
      extension("confirm-action", {
        actions: [action],
        types,
        widgets: { [definition.widget]: view },
        targets: {
          [action.target]: (input) => Effect.sync(() => {
            received.push(input)
            return { receipt: { sampleID: input.sampleID, marker: "published" }, note: "ok" }
          }),
        },
      }),
    ])

    const snapshot = yield* tools.snapshot(undefined, {
      context: { sessionID: Session.ID.make("ses_action"), agent: Agent.ID.make("build") },
    })
    const supplied = { sampleID: "CAL-28", confirmed: true }
    const approval = yield* openForm(execute(snapshot, supplied))
    expect(approval.form.title).toBe("Confirm publication")
    expect(approval.form.metadata).toMatchObject({ kind: "action", operation: "confirm", action: action.name })
    expect(received).toEqual([])
    const permission = { id: approval.form.id, answer: { confirmed: true } }
    yield* forms.reply(permission)
    expect((yield* forms.reply(permission).pipe(Effect.flip))._tag).toBe("Form.AlreadySettledError")
    yield* Fiber.join(approval.fiber)
    expect(received).toEqual([{ sampleID: "CAL-28" }])

    const cancel = yield* openForm(execute(snapshot, supplied).pipe(
      Effect.catchDefect((error) => error instanceof Form.CancelledError ? Effect.succeed(error) : Effect.die(error)),
    ))
    yield* forms.cancel(cancel.form.id)
    expect(yield* Fiber.join(cancel.fiber)).toBeInstanceOf(Form.CancelledError)

    const refusal = yield* openForm(execute(snapshot, supplied).pipe(
      Effect.catchDefect((error) => error instanceof Form.CancelledError ? Effect.succeed(error) : Effect.die(error)),
    ))
    yield* forms.reply({ id: refusal.form.id, answer: { confirmed: false } })
    expect(yield* Fiber.join(refusal.fiber)).toBeInstanceOf(Form.CancelledError)

    const expired = yield* openForm(execute(snapshot, supplied).pipe(Effect.flip))
    available = false
    yield* forms.reply({ id: expired.form.id, answer: { confirmed: true } })
    expect((yield* Fiber.join(expired.fiber)).message).toContain("not currently available")
    expect(received).toHaveLength(1)
  }),
)

it.live("reuses a named Editor for two Actions and validates the complete nested object before settling", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const forms = yield* Form.Service
    const calls: Array<{ action: string; input: Schema.JsonObject }> = []
    const booking = bookingType.mapFields((fields) => ({
      ...fields,
      preferences: Schema.Struct({ ownerID: Schema.String, label: Schema.optionalKey(Schema.String) }),
    }))
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
              ...bookingEditor,
              fields: [
                ...bookingEditor.fields,
                { path: ["preferences", "label"], type: "lightning__textType", title: "Label" },
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
    const known = { facility: " North Lab ", memo: " ", slot: { code: "CAL-418", duration: 40 }, preferences: { ownerID: "crew-4" } }
    for (const [index, { name }] of actions.entries()) {
      expect(snapshot.definitions.find((tool) => tool.name === name)?.inputSchema).toMatchObject({
        properties: { booking: { properties: { slot: { required: ["duration"] } } } },
      })
      const { form, fiber } = yield* openForm(execute(snapshot, { booking: known }, name))
      expect(form.title).toBe("Calibration booking")
      expect(form.metadata?.editor).toEqual({ channel: "lightningDesktopGenAi", definition: "fixture/calibration-booking-editor" })
      expect(form.fields).toEqual([
        expect.objectContaining({ key: "booking.facility", default: " North Lab " }),
        expect.objectContaining({ key: "booking.memo", default: " " }),
        expect.objectContaining({ key: "booking.slot.visitDate", format: "date" }),
        expect.objectContaining({ key: "booking.slot.code", default: "CAL-418" }),
        expect.objectContaining({ key: "booking.preferences.label" }),
      ])
      expect(calls).toHaveLength(index)
      const answer = {
        "booking.facility": index ? "South Lab" : " North Lab ",
        "booking.memo": " ",
        "booking.slot.visitDate": "2027-06-06",
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
          memo: " ",
          slot: { code: "CAL-501", visitDate: "2027-06-06", duration: 40 },
          preferences: known.preferences,
        } },
      })
    }
    const unavailable = yield* execute(snapshot, { booking: { facility: "North Lab" } }, names[0]).pipe(Effect.flip)
    expect(unavailable.message).toEndWith("booking.slot.duration")
    const missingOwner = yield* execute(snapshot, {
      booking: { facility: "North Lab", slot: { code: "CAL-418", visitDate: "2027-06-06", duration: 40 } },
    }, names[0]).pipe(Effect.flip)
    expect(missingOwner.message).toEndWith("booking.preferences.ownerID")
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
        types: {
          ...types,
          counts: Schema.Record(Schema.String, Schema.Number),
          failingCodec: Schema.String.check(Schema.makeFilter(() => { throw new Error("PRIVATE_CODEC_VALUE") })),
        },
        targets: {
          [definition.target]: (input) =>
            Effect.sync(() => {
              received.push(input)
              if (input.sampleID === "record") return { receipt: { PRIVATE_RECORD_KEY: "invalid count" } }
              if (input.sampleID === "codec") return { receipt: "encoded" }
              return { receipt: { marker: 123 }, undeclared: "SECRET" }
            }),
        },
        widgets: { [definition.widget]: view },
        actions: [
          { ...definition, name: "missing_target", target: "local://unknown" },
          { ...definition, name: "missing_type", inputs: { sampleID: { type: "unknown" } } },
          { ...definition, name: "missing_output_type", outputs: { receipt: { type: "unknown" } } },
          { ...definition, name: "dynamic_record", outputs: { receipt: { type: "counts" } } },
          { ...definition, name: "throwing_codec", outputs: { receipt: { type: "failingCodec" } } },
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
    expect(error.message).toBe('Action "inspect_sample" returned invalid outputs at outputs.receipt.sampleID')
    expect(error.metadata?.actionDiagnostic).toEqual({ stage: "actionSchema", path: "outputs.receipt.sampleID" })
    expect(error.metadata?.actionOutput).toBeUndefined()
    expect(received).toEqual([input])

    const recordError = yield* execute(snapshot, { sampleID: "record" }, "dynamic_record").pipe(Effect.flip)
    expect(recordError.metadata?.actionDiagnostic).toEqual({ stage: "actionSchema", path: "outputs.receipt" })
    expect(recordError.message).not.toContain("PRIVATE_RECORD_KEY")

    const defect = yield* execute(snapshot, { sampleID: "codec" }, "throwing_codec").pipe(Effect.catchDefect(Effect.succeed))
    expect(defect).toMatchObject({ message: 'Action "throwing_codec" returned invalid outputs at outputs' })
  }),
)

it.live("keeps the four named output combinations independent of the renderer and target failures", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const { widget, ...base } = definition
    const named = {
      ...base,
      renderer: "sample/renderer",
      outputs: {
        both: { type: "sampleId", is_displayable: true },
        user: { type: "sampleId", is_displayable: true, filter_from_agent: true },
        model: { type: "sampleId" },
        neither: { type: "sampleId", filter_from_agent: true },
      },
    } satisfies Definition
    const values = { both: "BOTH", user: "USER", model: "MODEL", neither: "NEITHER" }
    const user = { both: values.both, user: values.user }
    const model = { both: values.both, model: values.model }
    const namedView = { ...view, body: { definition: "tile/text", attributes: { text: "{!$attrs.both}" } } }
    yield* plugins.activate([
      extension("output-contract", {
        types,
        targets: {
          [named.target]: (input) => {
            if (input.sampleID === "defect") throw new Error(values.model)
            if (input.sampleID === "fail")
              return Effect.fail(new Tool.Error({ message: values.model, metadata: { actionOutput: { outputs: values } } }))
            return Effect.succeed({ ...values, undeclared: "UNDECLARED" })
          },
        },
        widgets: { [widget]: namedView, "sample/invalid": { ...namedView, label: "" } },
        renderers: {
          [named.renderer]: { type: "sampleId", widget },
          "sample/bad-widget": { type: "sampleId", widget: "sample/absent" },
          "sample/bad-type": { type: "receipt", widget },
        },
        actions: [
          named,
          { ...named, name: "unknown_renderer", renderer: "sample/absent" },
          { ...named, name: "unknown_widget", renderer: "sample/bad-widget" },
          { ...named, name: "wrong_renderer_type", renderer: "sample/bad-type" },
          { ...base, name: "invalid_widget", widget: "sample/invalid", outputs: named.outputs },
        ],
      }),
    ])

    const snapshot = yield* tools.snapshot()
    const input = { sampleID: "ok" }
    const result = yield* execute(snapshot, input)
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(model) }])
    expect(result.output).toEqual(model)
    expect(result.metadata?.actionOutput).toEqual({ outputs: user, view: { ...namedView, id: widget } })

    for (const [name, stage, path] of [
      ["unknown_renderer", "renderer", "renderers.sample/absent"],
      ["unknown_widget", "widget", "widgets.sample/absent"],
      ["wrong_renderer_type", "renderer", "renderers.sample/bad-type.type"],
      ["invalid_widget", "widget", "widgets.sample/invalid.label"],
    ] as const) {
      const fallback = yield* execute(snapshot, input, name)
      expect(fallback.output).toEqual(model)
      expect(fallback.metadata).toMatchObject({ actionOutput: { outputs: user }, actionDiagnostic: { stage, path } })
      expect(fallback.metadata?.actionOutput).not.toHaveProperty("view")
    }

    const failure = yield* execute(snapshot, { sampleID: "fail" }).pipe(Effect.flip)
    expect(failure.message).toBe('Action "inspect_sample" failed at target')
    expect(failure.metadata).toEqual({ actionDiagnostic: { stage: "actionResult", path: "target" } })

    const defect = yield* execute(snapshot, { sampleID: "defect" }).pipe(Effect.catchDefect(Effect.succeed))
    expect(defect).toMatchObject({ message: 'Action "inspect_sample" failed at target' })
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
