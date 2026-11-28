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
  let activeRead: AbortController | undefined

  const read = (target: FlightCard) => {
    const current = state()

    if (current.status === "absent" || current.target !== target) return

    activeRead?.abort()

    const controller = new AbortController()
    const attempt = Symbol()

    activeRead = controller
    dispatch({ type: "read.start", target, attempt })

    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])

    void Promise.try(() => target.host.get(target.card, signal)).then(
      (result) => {
        if (!controller.signal.aborted) dispatch({ type: "read", target, attempt, result })
      },
      () => {
        if (!controller.signal.aborted)
          dispatch({ type: "read", target, attempt, result: null, error: unavailable() })
      },
    )
  }

  createEffect(on(card, (target) => {
    dispatch({ type: "bind", target })

    if (!target) return

    const stop = target.host.listen((event) => {
      if (sameCard(event.card, target.card)) read(target)
    }, () => read(target))

    onCleanup(() => {
      activeRead?.abort()
      stop()
      dispatch({ type: "bind", target: undefined })
    })
    read(target)
  }))

  const run = (operation: Widget.Operation | undefined) => {
    const previous = state()

    if (previous.status !== "ready" || presentation(previous).busy) return

    const target = previous.target

    if (!operation || !FlightAction.reschedule(target.view, operation)) {
      dispatch({ type: "invalid", target, error: unavailable() })

      return
    }

    const attempt = Symbol()

    dispatch({ type: "start", target, attempt })
    void Promise.try(() =>
      target.host.change(
        { card: target.card, operation, revision: previous.result?.revision ?? target.card.callID },
        AbortSignal.timeout(300_000),
      ),
    ).then(
      (result) => {
        // The mutation response can arrive after another tab saved a later revision.
        if (result) read(target)

        dispatch({ type: "settled", target, attempt })
      },
      () => dispatch({ type: "settled", target, attempt, error: unavailable() }),
    )
  }

  return { view: createMemo(() => presentation(state())), run }
}
