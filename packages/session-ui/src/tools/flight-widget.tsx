import { FlightAction, Widget } from "@opencode/flight-action"
import { ActionWidget, flightWidgetResource, type WidgetActions } from "./action-widget"

export function FlightWidget(props: { view: FlightAction.View; label: string; actions?: WidgetActions }) {
  const tree = () => Widget.render(FlightAction.widget, flightWidgetResource, props.view.attributes)

  return <ActionWidget tree={tree()} label={props.label} actions={props.actions} />
}
