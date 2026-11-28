import { ActionOutput, FlightAction } from "@opencode/flight-action"
import { useI18n } from "@opencode/ui/context/i18n"
import { Option, Schema } from "effect"
import { createMemo, Match, Show, Switch } from "solid-js"
import { useData } from "../context"
import { ActionWidget, renderActionWidget, type WidgetActions } from "./action-widget"
import { createFlightChange } from "./flight-change"
import { FlightFailure, FlightWidget } from "./flight-widget"
import type { ToolProps } from "./tool-renderer"

const presentation = Schema.decodeUnknownOption(ActionOutput.Presentation)

const readDiagnostic = Schema.decodeUnknownOption(ActionOutput.Diagnostic)

const legacyView = Schema.decodeUnknownOption(FlightAction.View)

const readFlightFailure = Schema.decodeUnknownOption(FlightAction.Input)

export function ActionResult(
  props: Pick<ToolProps, "tool" | "status" | "metadata" | "sessionID" | "messageID" | "callID">,
) {
  const i18n = useI18n()
  const data = useData()
  const initial = createMemo(() => Option.getOrUndefined(presentation(props.metadata.actionOutput)))

  const legacy = createMemo(() =>
    props.tool === FlightAction.definition.name && !Object.hasOwn(props.metadata, "actionOutput")
      ? Option.getOrUndefined(legacyView(props.metadata.flightAction))
      : undefined,
  )

  const flightFailure = createMemo(() =>
    props.tool === FlightAction.definition.name && props.status === "error"
      ? Option.getOrUndefined(readFlightFailure(props.metadata.flightFailure))
      : undefined,
  )

  const card = createMemo(() => {
    const host = data.flightReschedule
    const sessionID = props.sessionID ?? data.sessionID
    const current = initial()

    if (
      !host || !data.flag("flight_action") || !sessionID || !props.messageID || !props.callID ||
      props.tool !== FlightAction.definition.name || (props.status !== "completed" && !flightFailure())
    ) return

    const view = current?.widget === FlightAction.widget ? FlightAction.bind(current.outputs).view : legacy()

    if (view || flightFailure()) return { host, card: { sessionID, messageID: props.messageID, callID: props.callID }, view }
  })

  const change = createFlightChange(card, () => i18n.t("ui.flightAction.unavailable"))

  const currentFailure = createMemo(() => {
    const revised = change.view().result

    return revised ? Option.getOrUndefined(readFlightFailure(revised.failure)) : flightFailure()
  })

  const result = createMemo(() => {
    const revised = change.view().result

    if (!revised) return initial()

    return revised.failure ? undefined : { widget: FlightAction.widget, outputs: revised.outputs }
  })

  const actions = createMemo<WidgetActions | undefined>(() => {
    const state = change.view()

    if (!card() || !state.available) return

    return {
      widget: FlightAction.widget,
      disabled: state.busy,
      buttonLabel: i18n.t("ui.flightAction.changeDate"),
      run: change.run,
    }
  })

  const widget = createMemo(() => {
    const item = result()

    return item ? renderActionWidget(item.widget, item.outputs, props.tool, i18n.t("ui.flightAction.empty")) : undefined
  })

  const widgetLabel = () => widget()?.label
  const failure = createMemo(() => Option.getOrUndefined(readDiagnostic(props.metadata.actionDiagnostic)))

  const output = createMemo(() => {
    const value = result()?.outputs

    if (!value) return

    const rejected = widget()?.rejectedOutput
    const visible = Object.entries(value).filter(([name]) => name !== rejected)

    return visible.length ? JSON.stringify(Object.fromEntries(visible), null, 2) : undefined
  })

  const diagnostic = () => {
    if (Object.hasOwn(props.metadata, "actionOutput") && !result()) return "$.metadata.actionOutput"

    return widget()?.diagnostic
  }

  return (
    <div data-component="action-result">
      <Switch>
        <Match when={props.status === "streaming" || props.status === "running"}>
          <span role="status">{i18n.t("ui.actionOutput.pending")}</span>
        </Match>
        <Match when={currentFailure()}>
          {(input) => (
            <>
              <FlightFailure
                input={input()}
                disabled={!change.view().available || change.view().busy}
                onRetry={card() ? () => change.run(FlightAction.retry) : undefined}
              />
              <Show when={change.view().error}>
                {(message) => <p role="alert">{message()}</p>}
              </Show>
            </>
          )}
        </Match>
        <Match when={props.status !== "completed" && !change.view().result}>
          <Show when={failure()} fallback={<span role="status">{i18n.t("ui.actionOutput.failed")}</span>}>
            {(item) => (
              <>
                <p role="alert">{i18n.t(`ui.actionOutput.diagnostic.${item().stage}`, { path: item().path })}</p>
                <Show when={output()}>{(text) => <OutputText text={text()} />}</Show>
              </>
            )}
          </Show>
        </Match>
        <Match when={true}>
          <Switch fallback={<span role="status">{i18n.t("ui.actionOutput.completed")}</span>}>
            <Match when={widget()?.tree}>
              {(tree) => <ActionWidget tree={tree()} label={i18n.t(widgetLabel() ?? "ui.actionOutput.completed")} actions={actions()} />}
            </Match>
            <Match when={legacy()}>
              {(flight) => <FlightWidget view={flight()} label={i18n.t("ui.flightAction.results")} actions={actions()} />}
            </Match>
          </Switch>
          <Show when={change.view().error}>
            {(message) => <p role="alert">{message()}</p>}
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
