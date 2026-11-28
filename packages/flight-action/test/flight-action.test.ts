import { expect, test } from "bun:test"
import { FlightAction, Widget } from "../src/flight-action.js"

const trip = { originCity: "杭州", destinationCity: "成都", dateOfTravel: "2026-12-05" }

test("keeps the supplied route and asks for just the missing or invalid date", () => {
  for (const dateOfTravel of [undefined, null, "", "2026-02-30"]) {
    const plan = FlightAction.prepare({ ...trip, dateOfTravel })
    expect(plan.values).toEqual({ originCity: "杭州", destinationCity: "成都" })
    expect(plan.fields).toEqual([{
      key: "dateOfTravel",
      title: "Departure date",
      type: "string",
      required: true,
      format: "date",
      placeholder: "YYYY-MM-DD",
    }])
    expect(FlightAction.run({ ...plan.values, dateOfTravel: trip.dateOfTravel }).model?.results).toMatchObject(trip)
  }
  expect(FlightAction.prepare(trip).fields).toEqual([])
})

test("uses a text field for missing cities and respects collection policy defaults", () => {
  expect(FlightAction.prepare({ ...trip, originCity: " " }).fields).toEqual([{
    key: "originCity",
    title: "Origin city",
    type: "string",
    required: true,
    pattern: "^\\s*\\S.*",
  }])
  const city = FlightAction.prepare({ ...trip, originCity: "" }).fields.find((field) => "pattern" in field)
  const pattern = new RegExp(`^(?:${city?.pattern})$`, "v")
  expect(pattern.test("杭州")).toBe(true)
  expect(pattern.test("   ")).toBe(false)
  expect(FlightAction.prepare({}, {}).fields).toEqual([])
  expect(() => FlightAction.prepare({}, { originCity: { is_required: true } })).toThrow("Origin city")
})

test("executes the registered target once and binds its actual flight data", () => {
  const calls: unknown[] = []
  const result = FlightAction.run(trip, (input) => {
    calls.push(input)
    const output = FlightAction.simulate(input)
    return { ...output, flights: output.flights.map((flight) => ({ ...flight, fare: 612 })) }
  })
  expect(calls).toEqual([trip])
  expect(result.user?.attributes.flights.map((flight) => flight.fare)).toEqual([612, 612])
  expect(JSON.parse(result.tool.content)).toMatchObject({ results: { ...trip } })
})

test("opens a prefilled date request using the registered node and preserves the route", () => {
  const invoked: unknown[] = []
  const execute = (input: unknown) => FlightAction.run(input, (query) => {
    invoked.push(query)
    return FlightAction.simulate(query)
  })
  const missing = FlightAction.prepare({ originCity: "杭州", destinationCity: "成都" })
  expect(missing.fields.map((field) => field.key)).toEqual(["dateOfTravel"])
  expect(invoked).toHaveLength(0)

  const initial = execute({ ...missing.values, dateOfTravel: "2026-12-05" }).user
  expect(initial?.attributes.flights[0]?.fare).toBe(560)
  if (!initial) throw new Error("Expected flight results")

  const node = Widget.render(FlightAction.widget, {
    definition: "tile/button",
    id: FlightAction.changeDate.node,
    attributes: {
      label: "改日期",
      actions: { click: [{ definition: "action/sendMessage", attributes: { content: "Localize this too" } }] },
    },
  }, initial.attributes)
  const operation = Widget.operation(FlightAction.widget, node)
  const change = FlightAction.reschedule(initial, operation)
  expect(change?.values).toEqual({ originCity: "杭州", destinationCity: "成都" })
  expect(change?.fields).toMatchObject([{ key: "dateOfTravel", default: "2026-12-05", format: "date" }])
  expect(FlightAction.reschedule(initial, { ...FlightAction.changeDate, node: "unknown" })).toBeUndefined()
  expect(FlightAction.reschedule(initial, { ...FlightAction.changeDate, definition: "action/openLink" })).toBeUndefined()
  expect(FlightAction.reschedule(initial, { ...FlightAction.changeDate, widget: "@widget/c/customerReviews" })).toBeUndefined()
  expect(invoked).toHaveLength(1)

  const updated = execute({ ...change?.values, dateOfTravel: "2026-12-06" }).user
  expect(updated?.attributes.flights[0]?.fare).toBe(570)
  expect(invoked).toEqual([trip, { ...trip, dateOfTravel: "2026-12-06" }])
  expect(initial.attributes.dateOfTravel).toBe("2026-12-05")
})

test("an empty flight search can change date without re-running the original search", () => {
  const empty = { ...trip, dateOfTravel: "2026-12-04" }
  const calls: unknown[] = []
  const search = (input: unknown) => FlightAction.run(input, (query) => {
    calls.push(query)
    return FlightAction.simulate(query, "search")
  })
  const initial = search(empty)

  expect(initial.user?.attributes).toEqual({ ...empty, flights: [] })
  if (!initial.user) throw new Error("Expected an empty flight result")
  const change = FlightAction.reschedule(initial.user, FlightAction.changeDate)

  expect(change?.fields[0]?.default).toBe(empty.dateOfTravel)
  expect(calls).toEqual([empty])

  const dateOfTravel = "2026-12-06"
  const revised = search({ ...change?.values, dateOfTravel })

  expect(revised.user?.attributes.flights[0]?.fare).toBe(570)
  expect(calls).toEqual([empty, { ...trip, dateOfTravel }])
})

test("a failed search can recover on an explicit retry of the same query", () => {
  const unavailable = { ...trip, dateOfTravel: "2026-12-08" }

  expect(FlightAction.run(unavailable).user?.attributes.flights).toHaveLength(2)
  expect(() => FlightAction.run(unavailable, (input) => FlightAction.simulate(input, "search"))).toThrow("Flight search failed")
  expect(() => FlightAction.run(unavailable, (input) => FlightAction.simulate(input, "reschedule"))).toThrow("Flight search failed")

  const recovered = FlightAction.run(unavailable, (input) => FlightAction.simulate(input, "retry"))

  expect(recovered.user?.attributes).toMatchObject({
    ...unavailable,
    flights: [{ number: "CA 1741", fare: 560 }, { number: "MU 5495", fare: 620 }],
  })
})

test("reports a rejected named value separately from its Widget diagnostic", () => {
  const results = FlightAction.simulate(trip)
  const first = { ...results.flights[0], fare: "560" }
  expect(FlightAction.bind({ results: { ...results, flights: [first] } })).toEqual({
    rejectedOutput: "results",
    path: "$.outputs.results.flights.0.fare",
  })
  expect(FlightAction.bind({ notice: "available" })).toEqual({ path: "$.outputs.results" })
})

test("rejects an invalid date before calling the target and rejects invalid target output", () => {
  const calls: unknown[] = []
  expect(() =>
    FlightAction.run({ ...trip, dateOfTravel: "2026-02-30" }, (input) => calls.push(input)),
  ).toThrow()
  expect(calls).toEqual([])
  expect(() => FlightAction.run(trip, () => ({ ...trip, flights: [{ fare: "560" }] }))).toThrow()
})
