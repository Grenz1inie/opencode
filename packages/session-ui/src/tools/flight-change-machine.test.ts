import { expect, test } from "bun:test"
import { FlightAction } from "@opencode/flight-action"
import { initial, presentation, transition, type FlightCard } from "./flight-change-machine"

const target: FlightCard = {
  card: { sessionID: "session", messageID: "message", callID: "original" },
  view: {
    definition: FlightAction.widget,
    attributes: { originCity: "杭州", destinationCity: "成都", dateOfTravel: "2026-12-05", flights: [] },
  },
  host: {
    get: async () => null,
    change: async () => null,
    listen: () => () => undefined,
  },
}

const revised = { revision: "revised", outputs: {} }

test("settles each date change once and keeps the previous result when a form is cancelled", () => {
  const loading = transition(initial, { type: "bind", target })
  const ready = transition(loading, { type: "read", target, result: null })
  const changing = transition(ready, { type: "start", target })

  expect(presentation(changing)).toMatchObject({ busy: true, result: null })
  expect(transition(changing, { type: "start", target })).toBe(changing)

  const saved = transition(changing, { type: "settled", target, result: revised })
  const second = transition(saved, { type: "start", target })
  const cancelled = transition(second, { type: "settled", target, result: null })

  expect(presentation(cancelled)).toEqual({ available: true, busy: false, result: revised, error: undefined })
})

test("keeps an update received before the initial read and ignores a reply from a previous card", () => {
  const loading = transition(initial, { type: "bind", target })
  const updated = transition(loading, { type: "published", target, result: revised })

  expect(transition(updated, { type: "read", target, result: null })).toBe(updated)

  const other = { ...target, card: { ...target.card, callID: "other" } }
  const current = transition(updated, { type: "bind", target: other })

  expect(transition(current, { type: "settled", target, result: revised })).toBe(current)
  expect(presentation(transition(current, { type: "read", target: other, result: null, error: "Unavailable" })))
    .toMatchObject({ available: true, busy: false, result: null, error: "Unavailable" })
})
