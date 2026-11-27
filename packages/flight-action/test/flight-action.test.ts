import { expect, test } from "bun:test"
import { FlightAction } from "../src/flight-action.js"

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
    pattern: "\\S",
  }])
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
  expect(result.model?.results.flights[0]?.fare).toBe(612)
})

test("rejects an invalid date before calling the target and rejects invalid target output", () => {
  const calls: unknown[] = []
  expect(() =>
    FlightAction.run({ ...trip, dateOfTravel: "2026-02-30" }, (input) => calls.push(input)),
  ).toThrow()
  expect(calls).toEqual([])
  expect(() => FlightAction.run(trip, () => ({ ...trip, flights: [{ fare: "560" }] }))).toThrow()
})
