import { FlightAction } from "@opencode/flight-action"
import { For, Match, Switch } from "solid-js"
import "./flight-widget.css"

type Scope = Readonly<Record<string, unknown>>
type Node = {
  definition: "tile/widget" | "tile/column" | "tile/row" | "tile/text"
  attributes?: { text: string; variant?: "h3" | "h4" }
  children?: readonly Node[]
  meta?: { forEach: string; forItem: string }
}

const resource = {
  type: "lightning__agentforceWidget",
  contentBody: {
    widgetBody: {
      definition: "tile/widget",
      children: [
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
      ],
    },
  },
} satisfies { type: "lightning__agentforceWidget"; contentBody: { widgetBody: Node } }

export function FlightWidget(props: { view: FlightAction.View; label: string }) {
  return (
    <section aria-label={props.label} class="flight-widget">
      <For each={resource.contentBody.widgetBody.children}>
        {(node) => <WidgetNode node={node} scope={{ $attrs: props.view.attributes }} />}
      </For>
    </section>
  )
}

function WidgetNode(props: { node: Node; scope: Scope }) {
  const loop = () => props.node.meta && FlightAction.readBinding(props.node.meta.forEach, props.scope)
  return (
    <Switch fallback={<WidgetElement node={props.node} scope={props.scope} />}>
      <Match when={props.node.meta}>
        {(meta) => (
          <For each={list(loop())}>
            {(item) => <WidgetElement node={props.node} scope={{ ...props.scope, [meta().forItem]: item }} />}
          </For>
        )}
      </Match>
    </Switch>
  )
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function WidgetElement(props: { node: Node; scope: Scope }) {
  const text = () =>
    props.node.attributes?.text.replace(/\{![^}]+\}/g, (token) => {
      const value = FlightAction.readBinding(token, props.scope)
      return typeof value === "string" || typeof value === "number" ? String(value) : ""
    })
  const children = () => <For each={props.node.children}>{(node) => <WidgetNode node={node} scope={props.scope} />}</For>
  return (
    <Switch>
      <Match when={props.node.definition === "tile/column"}>
        <article class="flight-widget-card">{children()}</article>
      </Match>
      <Match when={props.node.definition === "tile/row"}>
        <div class="flight-widget-row">{children()}</div>
      </Match>
      <Match when={props.node.attributes?.variant === "h4"}>
        <h4>{text()}</h4>
      </Match>
      <Match when={props.node.definition === "tile/text"}>
        <span>{text()}</span>
      </Match>
    </Switch>
  )
}
