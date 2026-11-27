import { FlightAction, Widget } from "@opencode/flight-action"
import { ActionWidget, flightWidgetResource } from "./action-widget"

export function FlightWidget(props: { view: FlightAction.View; label: string }) {
  const tree = () => Widget.render(FlightAction.widget, flightWidgetResource, props.view.attributes)
  return <ActionWidget tree={tree()} label={props.label} />
}
