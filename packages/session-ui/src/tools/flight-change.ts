import { FlightAction, type Widget } from "@opencode/flight-action"
import type { FlightReschedule } from "@opencode/schema/flight-reschedule"
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { initial, presentation, transition, type FlightCard } from "./flight-change-machine"

function sameCard(left: FlightReschedule.Card, right: FlightReschedule.Card) {
  return left.sessionID === right.sessionID && left.messageID === right.messageID && left.callID === right.callID
}

export function createFlightChange(card: () => FlightCard | undefined, unavailable: () => string) {
  const [state, setState] = createSignal(initial)
  const dispatch = (event: Parameters<typeof transition>[1]) => setState((current) => transition(current, event))

  createEffect(on(card, (target) => {
    dispatch({ type: "bind", target })

    if (!target) return

    const controller = new AbortController()

    const stop = target.host.listen((event) => {
      if (sameCard(event.card, target.card)) dispatch({ type: "published", target, result: event.result })
    })

    onCleanup(() => {
      controller.abort()
      stop()
      dispatch({ type: "bind", target: undefined })
    })

    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
    void Promise.try(() => target.host.get(target.card, signal)).then(
      (result) => dispatch({ type: "read", target, result }),
      () => {
        if (!controller.signal.aborted)
          dispatch({ type: "read", target, result: null, error: unavailable() })
      },
    )
  }))

  const run = (operation: Widget.Operation | undefined) => {
    const previous = state()

    if (previous.status !== "ready") return

    const target = previous.target

    if (!operation || !FlightAction.reschedule(target.view, operation)) {
      dispatch({ type: "invalid", target, error: unavailable() })

      return
    }

    dispatch({ type: "start", target })
    void Promise.try(() =>
      target.host.change(
        { card: target.card, operation, revision: previous.result?.revision ?? target.card.callID },
        AbortSignal.timeout(300_000),
      ),
    ).then(
      (result) => dispatch({ type: "settled", target, result }),
      () => dispatch({ type: "settled", target, result: null, error: unavailable() }),
    )
  }

  return { view: createMemo(() => presentation(state())), run }
}
