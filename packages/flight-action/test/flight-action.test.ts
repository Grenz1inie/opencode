import { expect, test } from "bun:test"
import { FlightAction } from "../src/flight-action.js"

const trip = { originCity: "杭州", destinationCity: "成都", dateOfTravel: "2026-12-05" }

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
