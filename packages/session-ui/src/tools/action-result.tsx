import { ActionOutput, FlightAction } from "@opencode/flight-action"
import { useI18n } from "@opencode/ui/context/i18n"
import { Option, Schema } from "effect"
import { createMemo, Match, Show, Switch } from "solid-js"
import { FlightWidget } from "./flight-widget"
import type { ToolProps } from "./tool-renderer"

const presentation = Schema.decodeUnknownOption(ActionOutput.Presentation)
const legacyView = Schema.decodeUnknownOption(FlightAction.View)

export function ActionResult(props: Pick<ToolProps, "tool" | "status" | "metadata">) {
  const i18n = useI18n()
  const result = createMemo(() => Option.getOrUndefined(presentation(props.metadata.actionOutput)))
  const legacy = createMemo(() =>
    props.tool === FlightAction.definition.name && !Object.hasOwn(props.metadata, "actionOutput")
      ? Option.getOrUndefined(legacyView(props.metadata.flightAction))
      : undefined,
  )
  const binding = createMemo<ReturnType<typeof FlightAction.bind> | undefined>(() => {
    const item = result()

    if (!item?.widget) return

    return item.widget === FlightAction.widget ? FlightAction.bind(item.outputs) : { path: "$.widget" }
  })
  const view = () => binding()?.view ?? legacy()
  const output = createMemo(() => {
    const value = result()?.outputs

    return value && Object.keys(value).length ? JSON.stringify(value, null, 2) : undefined
  })
  const diagnostic = () => {
    if (Object.hasOwn(props.metadata, "actionOutput") && !result()) return "$.metadata.actionOutput"

    const path = binding()?.path

    if (!path) return

    // Only a registered identifier is shown. A broken or unregistered reference is not a source of display text.
    return result()?.widget === FlightAction.widget ? `${FlightAction.widget} · ${path}` : path
  }

  return (
    <div data-component="action-result">
      <Switch>
        <Match when={props.status === "streaming" || props.status === "running"}>
          <span role="status">{i18n.t("ui.actionOutput.pending")}</span>
        </Match>
        <Match when={props.status !== "completed"}>
          <span role="status">{i18n.t("ui.actionOutput.failed")}</span>
        </Match>
        <Match when={true}>
          <Show when={view()} fallback={<span role="status">{i18n.t("ui.actionOutput.completed")}</span>}>
            {(flight) => <FlightWidget view={flight()} label={i18n.t("ui.flightAction.results")} />}
          </Show>
          <Show
            when={diagnostic()}
            fallback={
              <Show when={output()}>
                {(text) => (
                  <details>
                    <summary>{i18n.t("ui.actionOutput.details")}</summary>
                    <OutputText text={text()} />
                  </details>
                )}
              </Show>
            }
          >
            {(path) => (
              <>
                <p role="status">{i18n.t("ui.actionOutput.invalid", { path: path() })}</p>
                <Show when={output()}>{(text) => <OutputText text={text()} />}</Show>
              </>
            )}
          </Show>
        </Match>
      </Switch>
    </div>
  )
}

function OutputText(props: { text: string }) {
  return <pre class="whitespace-pre-wrap break-all">{props.text}</pre>
}
