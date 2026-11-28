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

const newest = { revision: "newest", outputs: {} }

function loaded(result: typeof revised | null) {
  const loading = transition(initial, { type: "bind", target })
  const attempt = Symbol()
  const reading = transition(loading, { type: "read.start", target, attempt })

  return transition(reading, { type: "read", target, attempt, result })
}

test("settles each date change once and keeps the previous result when a form is cancelled", () => {
  const ready = loaded(revised)
  const attempt = Symbol()
  const changing = transition(ready, { type: "start", target, attempt })

  expect(presentation(changing)).toMatchObject({ busy: true, result: revised })
  expect(transition(changing, { type: "start", target, attempt: Symbol() })).toBe(changing)
  expect(transition(changing, { type: "settled", target, attempt: Symbol() })).toBe(changing)

  const cancelled = transition(changing, { type: "settled", target, attempt })

  expect(presentation(cancelled)).toEqual({ available: true, busy: false, result: revised, error: undefined })
})

test("restores a missed revision on reconnect and ignores an overlapping older read", () => {
  const ready = loaded(null)
  const stale = Symbol()
  const current = Symbol()
  const pending = transition(ready, { type: "read.start", target, attempt: stale })
  const reconnect = transition(pending, { type: "read.start", target, attempt: current })

  expect(presentation(reconnect)).toMatchObject({ busy: true, result: null })
  expect(transition(reconnect, { type: "read", target, attempt: stale, result: revised })).toBe(reconnect)

  const recovered = transition(reconnect, { type: "read", target, attempt: current, result: newest })

  expect(presentation(recovered)).toMatchObject({ busy: false, result: newest })

  const retry = Symbol()
  const failed = transition(recovered, { type: "read.start", target, attempt: retry })
  const unavailable = transition(failed, { type: "read", target, attempt: retry, result: null, error: "Unavailable" })

  expect(presentation(unavailable)).toMatchObject({ busy: false, result: newest, error: "Unavailable" })
})

test("a delayed change response cannot invalidate the reconnect read or replace its saved result", () => {
  const ready = loaded(null)
  const change = Symbol()
  const read = Symbol()
  const changing = transition(ready, { type: "start", target, attempt: change })
  const reconnect = transition(changing, { type: "read.start", target, attempt: read })
  const settled = transition(reconnect, { type: "settled", target, attempt: change })
  const recovered = transition(settled, { type: "read", target, attempt: read, result: newest })

  expect(presentation(settled)).toMatchObject({ busy: true })
  expect(presentation(recovered)).toMatchObject({ busy: false, result: newest })
})

test("ignores a read from a previous card or session", () => {
  const ready = loaded(revised)
  const attempt = Symbol()
  const reading = transition(ready, { type: "read.start", target, attempt })
  const other = { ...target, card: { ...target.card, sessionID: "other" } }
  const current = transition(reading, { type: "bind", target: other })

  expect(transition(current, { type: "read", target, attempt, result: revised })).toBe(current)
})
