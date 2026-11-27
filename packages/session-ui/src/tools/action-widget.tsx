import { ActionOutput, CustomerReviews, FlightAction, Widget } from "@opencode/flight-action"
import type { Schema } from "effect"
import { For, Match, Switch } from "solid-js"
import "./flight-widget.css"

const resource = {
  type: "lightning__agentforceWidget",
  contentBody: {
    widgetBody: {
      definition: "tile/widget",
      children: [
        { definition: "tile/text", attributes: { text: "Flights on {!$attrs.dateOfTravel}", variant: "h2" } },
        {
          definition: "tile/column",
          meta: { forEach: "{!$attrs.flights}", forItem: "$flight" },
          children: [
            { definition: "tile/text", attributes: { text: "{!$flight.number}", variant: "h4" } },
            { definition: "tile/text", attributes: { text: "{!$attrs.originCity} → {!$attrs.destinationCity}" } },
            { definition: "tile/text", attributes: { text: "{!$attrs.dateOfTravel}" } },
            {
              definition: "tile/row",
              children: [
                { definition: "tile/text", attributes: { text: "{!$flight.departure} → {!$flight.arrival}" } },
                { definition: "tile/text", attributes: { text: "{!$flight.duration}" } },
                { definition: "tile/text", attributes: { text: "¥{!$flight.fare}" } },
              ],
            },
          ],
        },
        {
          definition: "tile/button",
          id: FlightAction.changeDate.node,
          attributes: {
            label: "Change date",
            actions: { click: [{ definition: FlightAction.changeDate.definition, attributes: { content: "Change the travel date" } }] },
          },
        },
      ],
    },
  },
} satisfies { type: "lightning__agentforceWidget"; contentBody: { widgetBody: Widget.Node } }

export const flightWidgetResource = resource.contentBody.widgetBody

type Registration = {
  widget: string
  tool: string
  output: string
  resource: Widget.Node
  label: "ui.flightAction.results" | "ui.customerReviews.results"
  bind: (outputs: Schema.JsonObject) => ActionOutput.Binding<{ attributes: Schema.JsonObject }>
}

const registry: readonly Registration[] = [
  {
    widget: FlightAction.widget,
    tool: FlightAction.definition.name,
    output: "results",
    resource: flightWidgetResource,
    label: "ui.flightAction.results",
    bind: FlightAction.bind,
  },
  {
    widget: CustomerReviews.widget,
    tool: CustomerReviews.name,
    output: "reviews",
    resource: CustomerReviews.resource,
    label: "ui.customerReviews.results",
    bind: CustomerReviews.bind,
  },
]

export function renderActionWidget(widget: string | undefined, outputs: Schema.JsonObject, tool?: string) {
  const entry = registry.find((registration) => registration.widget === widget)
  const known = registry.find((registration) => registration.tool === tool && Object.hasOwn(outputs, registration.output))
  const source = known ?? entry
  const result = source?.bind(outputs)
  const rejectedOutput = result?.rejectedOutput

  if (widget && (!entry || source !== entry)) return { diagnostic: "$.widget", rejectedOutput }

  if (!source || !result) return {}

  if (!result.view) return { diagnostic: `${source.widget} · ${result.path ?? "$.outputs"}`, rejectedOutput }

  if (!entry) return {}

  try {
    return { tree: Widget.render(entry.widget, entry.resource, result.view.attributes), label: entry.label }
  } catch (error) {
    if (!(error instanceof Widget.BindingError)) throw error

    return { diagnostic: error.message }
  }
}

export type WidgetActions = {
  widget: string
  disabled?: boolean
  buttonLabel?: string
  run: (operation: Widget.Operation | undefined) => void
}

export function ActionWidget(props: { tree: Widget.Rendered; label: string; actions?: WidgetActions }) {
  return (
    <section aria-label={props.label} class="flight-widget">
      <WidgetElement node={props.tree} actions={props.actions} />
    </section>
  )
}

function WidgetElement(props: { node: Widget.Rendered; actions?: WidgetActions }) {
  const attributes = () => props.node.attributes

  const gap = () => {
    const value = attributes()?.gap

    return value === "sm" || value === "md" || value === "lg" ? value : undefined
  }

  const children = () => <For each={props.node.children}>{(node) => <WidgetElement node={node} actions={props.actions} />}</For>

  return (
    <Switch>
      <Match when={props.node.definition === "tile/widget"}>{children()}</Match>
      <Match when={props.node.definition === "tile/column" && props.node.repeated}>
        <article class="flight-widget-card" data-gap={gap()}>{children()}</article>
      </Match>
      <Match when={props.node.definition === "tile/column"}>
        <div class="action-widget-column" data-gap={gap()}>{children()}</div>
      </Match>
      <Match when={props.node.definition === "tile/row"}>
        <div
          class="flight-widget-row"
          data-gap={gap()}
          data-justify={attributes()?.justify === "between" ? "between" : undefined}
          data-align={attributes()?.align === "center" ? "center" : undefined}
        >
          {children()}
        </div>
      </Match>
      <Match when={props.node.definition === "tile/icon" && attributes()?.name === "star"}>
        <span class="action-widget-star" role="img" aria-label={String(attributes()?.alt ?? "")}>★</span>
      </Match>
      <Match when={props.node.definition === "tile/separator"}>
        <hr class="action-widget-separator" />
      </Match>
      <Match when={props.node.definition === "tile/button" && props.actions}>
        {(actions) => (
          <button
            type="button"
            class="action-widget-button"
            disabled={actions().disabled}
            onClick={() => actions().run(Widget.operation(actions().widget, props.node))}
          >
            {actions().buttonLabel ?? String(attributes()?.label ?? "")}
          </button>
        )}
      </Match>
      <Match when={props.node.definition === "tile/text" && attributes()?.variant === "h2"}>
        <h2 class="action-widget-heading">{props.node.text}</h2>
      </Match>
      <Match when={props.node.definition === "tile/text" && attributes()?.variant === "h4"}>
        <h4>{props.node.text}</h4>
      </Match>
      <Match when={props.node.definition === "tile/text"}>
        <span
          data-muted={attributes()?.color === "muted" ? "" : undefined}
          data-caption={attributes()?.variant === "caption" ? "" : undefined}
          data-semibold={attributes()?.weight === "semibold" ? "" : undefined}
        >{props.node.text}</span>
      </Match>
    </Switch>
  )
}
