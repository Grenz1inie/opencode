import type { FlightAction } from "@opencode/flight-action"
import { useI18n } from "@opencode/ui/context/i18n"
import { ActionWidget, renderFlightWidget, type WidgetActions } from "./action-widget"

export function FlightWidget(props: { view: FlightAction.View; label: string; actions?: WidgetActions }) {
  const i18n = useI18n()
  const tree = () => renderFlightWidget(props.view.attributes, i18n.t("ui.flightAction.empty"))

  return <ActionWidget tree={tree()} label={props.label} actions={props.actions} />
}
