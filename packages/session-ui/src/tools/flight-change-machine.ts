import type { FlightAction } from "@opencode/flight-action"
import type { FlightReschedule } from "@opencode/schema/flight-reschedule"
import type { FlightRescheduleHost } from "../context"

export type FlightCard = {
  card: FlightReschedule.Card
  host: FlightRescheduleHost
  view?: FlightAction.View
}

type Result = FlightReschedule.Result | null

type Bound = { target: FlightCard; readAttempt?: symbol }

type State =
  | { status: "absent" }
  | (Bound & { status: "loading" })
  | (Bound & { status: "ready"; result: Result; error?: string })
  | (Bound & { status: "changing"; changeAttempt: symbol; result: Result })

type Event =
  | { type: "bind"; target: FlightCard | undefined }
  | { type: "read.start"; target: FlightCard; attempt: symbol }
  | { type: "read"; target: FlightCard; attempt: symbol; result: Result; error?: string }
  | { type: "start"; target: FlightCard; attempt: symbol }
  | { type: "settled"; target: FlightCard; attempt: symbol; result?: Result; baseRevision?: string; error?: string }
  | { type: "invalid"; target: FlightCard; error: string }

export const initial: State = { status: "absent" }

export function transition(state: State, event: Event): State {
  if (event.type === "bind") return event.target ? { status: "loading", target: event.target } : initial

  if (state.status === "absent" || state.target !== event.target) return state

  switch (event.type) {
    case "read.start":
      return { ...state, readAttempt: event.attempt }
    case "read": {
      if (state.readAttempt !== event.attempt) return state

      const result = event.result ?? (state.status === "loading" ? null : state.result)

      if (state.status === "changing") return { ...state, readAttempt: undefined, result }

      return { status: "ready", target: state.target, result, error: event.error }
    }

    case "invalid":
      return state.status === "ready" ? { ...state, error: event.error } : state
    case "start":
      if (state.status !== "ready" || state.readAttempt !== undefined) return state

      return { status: "changing", target: state.target, result: state.result, changeAttempt: event.attempt }
    case "settled":
      if (state.status !== "changing" || state.changeAttempt !== event.attempt) return state

      return {
        status: "ready",
        target: state.target,
        result: state.result?.revision === event.baseRevision ? (event.result ?? state.result) : state.result,
        readAttempt: state.readAttempt,
        error: event.error,
      }
  }
}

export function presentation(state: State) {
  return {
    available: state.status === "ready" || state.status === "changing",
    busy: state.status === "changing" || (state.status === "ready" && state.readAttempt !== undefined),
    result: "result" in state ? state.result : null,
    error: state.status === "ready" ? state.error : undefined,
  }
}
