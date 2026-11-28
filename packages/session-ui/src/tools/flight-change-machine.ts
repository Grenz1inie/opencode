import type { FlightAction } from "@opencode/flight-action"
import type { FlightReschedule } from "@opencode/schema/flight-reschedule"
import type { FlightRescheduleHost } from "../context"

export type FlightCard = {
  card: FlightReschedule.Card
  host: FlightRescheduleHost
  view: FlightAction.View
}

type Result = FlightReschedule.Result | null

type State =
  | { status: "absent" }
  | { status: "loading"; target: FlightCard }
  | { status: "ready"; target: FlightCard; result: Result; error?: string }
  | { status: "changing"; target: FlightCard; result: Result }

type Event =
  | { type: "bind"; target: FlightCard | undefined }
  | { type: "read" | "settled"; target: FlightCard; result: Result; error?: string }
  | { type: "published"; target: FlightCard; result: FlightReschedule.Result }
  | { type: "invalid"; target: FlightCard; error: string }
  | { type: "start"; target: FlightCard }

export const initial: State = { status: "absent" }

export function transition(state: State, event: Event): State {
  if (event.type === "bind") return event.target ? { status: "loading", target: event.target } : initial

  if (state.status === "absent" || state.target !== event.target) return state

  switch (event.type) {
    case "read":
      if (state.status !== "loading") return state

      return { ...state, status: "ready", result: event.result, error: event.error }
    case "published":
      if (state.status === "changing") return { ...state, result: event.result }

      return { ...state, status: "ready", result: event.result, error: undefined }
    case "invalid":
      return state.status === "ready" ? { ...state, error: event.error } : state
    case "start":
      if (state.status !== "ready") return state

      return { status: "changing", target: state.target, result: state.result }
    case "settled":
      if (state.status !== "changing") return state

      return { ...state, status: "ready", result: event.result ?? state.result, error: event.error }
  }
}

export function presentation(state: State) {
  return {
    available: state.status === "ready" || state.status === "changing",
    busy: state.status === "changing",
    result: "result" in state ? state.result : null,
    error: state.status === "ready" ? state.error : undefined,
  }
}
