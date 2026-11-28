import type { FlightAction } from "@opencode/flight-action"
import { useI18n } from "@opencode/ui/context/i18n"
import { Show } from "solid-js"
import { ActionWidget, renderFlightWidget, type WidgetActions } from "./action-widget"

export function FlightWidget(props: { view: FlightAction.View; label: string; actions?: WidgetActions }) {
  const i18n = useI18n()
  const tree = () => renderFlightWidget(props.view.attributes, i18n.t("ui.flightAction.empty"))

  return <ActionWidget tree={tree()} label={props.label} actions={props.actions} />
}

export function FlightFailure(props: { input: FlightAction.Input; disabled?: boolean; onRetry?: () => void }) {
  const i18n = useI18n()

  return (
    <section aria-label={i18n.t("ui.flightAction.failed")} class="flight-widget">
      <h2 class="action-widget-heading">{props.input.dateOfTravel}</h2>
      <p>{props.input.originCity} → {props.input.destinationCity}</p>
      <p role="alert">{i18n.t("ui.flightAction.failed")}</p>
      <Show when={props.onRetry}>
        {(retry) => (
          <button type="button" class="action-widget-button" disabled={props.disabled} onClick={retry()}>
            {i18n.t("ui.flightAction.retry")}
          </button>
        )}
      </Show>
    </section>
  )
}
