import { FlightAction } from "@opencode/flight-action"
import { FlightFailure, FlightWidget } from "@opencode/session-ui/flight-widget"
import { useI18n } from "@opencode/ui/context/i18n"
import { Schema } from "effect"
import { createSignal, For, Show } from "solid-js"
import { render } from "solid-js/web"

type FlightResult =
  | { view: FlightAction.View; failure?: never; awaitingRetry?: never }
  | { failure: FlightAction.Input; view?: never; awaitingRetry?: boolean }

const decodeInput = Schema.decodeUnknownSync(FlightAction.Input)

function Demo() {
  const i18n = useI18n()
  const [result, setResult] = createSignal<FlightResult>()
  const view = () => result()?.view
  const [status, setStatus] = createSignal("")
  const [pending, setPending] = createSignal<ReturnType<typeof FlightAction.prepare>>()

  const [draft, setDraft] = createSignal({
    originCity: "杭州",
    destinationCity: "成都",
    dateOfTravel: "2026-12-05",
  })

  function search(query: FlightAction.Input, attempt: FlightAction.Attempt = "search") {
    setDraft(query)
    setPending(undefined)
    setStatus("")
    console.debug("Flight search target invoked", { ...query, attempt })

    try {
      const view = FlightAction.run(query, (saved) => FlightAction.simulate(saved, attempt)).user
      setResult(view ? { view } : { failure: query })
    } catch {
      setResult({ failure: query })
    }
  }

  return (
    <>
      <h1>Simulated flight search</h1>
      <Show
        when={pending()}
        fallback={
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const data = new FormData(event.currentTarget)

              const next = {
                originCity: String(data.get("originCity") ?? ""),
                destinationCity: String(data.get("destinationCity") ?? ""),
                dateOfTravel: String(data.get("dateOfTravel") ?? ""),
              }

              setDraft(next)
              setResult(undefined)
              const prepared = FlightAction.prepare(next)

              if (prepared.fields.length === 0) search(decodeInput(prepared.values))
              else setPending(prepared)
            }}
          >
            <label>Origin city<input name="originCity" value={draft().originCity} /></label>
            <label>Destination city<input name="destinationCity" value={draft().destinationCity} /></label>
            <label>Departure date<input name="dateOfTravel" type="date" value={draft().dateOfTravel} /></label>
            <button type="submit">Find flights</button>
          </form>
        }
      >
        {(request) => (
          <form
            aria-label={view() ? "Change flight date" : "Flight search details"}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return
              setPending(undefined)
              setStatus("")
            }}
            onSubmit={(event) => {
              event.preventDefault()
              const next = { ...request().values, ...Object.fromEntries(new FormData(event.currentTarget)) }
              const prepared = FlightAction.prepare(next)

              if (prepared.fields.length > 0) {
                setStatus("Enter all required flight details.")

                return
              }

              search(decodeInput(prepared.values), view() ? "reschedule" : "search")
            }}
          >
            <p>{[request().values.originCity, request().values.destinationCity].filter(Boolean).join(" → ")}</p>
            <For each={request().fields}>
              {(field) => (
                <label>
                  {field.title}
                  <input
                    name={field.key}
                    type={field.format === "date" ? "date" : "text"}
                    pattern={field.pattern}
                    value={field.default}
                    required
                    ref={field.format === "date" ? (input) => queueMicrotask(() => input.focus()) : undefined}
                  />
                </label>
              )}
            </For>
            <button type="submit">Continue search</button>
            <button type="button" onClick={() => { setPending(undefined); setStatus("") }}>Cancel</button>
          </form>
        )}
      </Show>
      <div role="status">{status()}</div>
      <Show when={result()?.failure}>
        {(input) => (
          <>
            <FlightFailure
              input={input()}
              disabled={result()?.awaitingRetry}
              onRetry={() => setResult({ failure: input(), awaitingRetry: true })}
            />
            <Show when={result()?.awaitingRetry}>
              <form
                aria-label={i18n.t("ui.flightAction.retryPermission")}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return

                  event.preventDefault()
                  setResult({ failure: input() })
                }}
                onSubmit={(event) => {
                  event.preventDefault()
                  search(input(), "retry")
                }}
              >
                <p>{i18n.t("ui.flightAction.retryPermission")}</p>
                <button
                  type="button"
                  ref={(button) => queueMicrotask(() => button.focus({ preventScroll: true }))}
                  onClick={() => setResult({ failure: input() })}
                >
                  {i18n.t("ui.permission.deny")}
                </button>
                <button type="submit">{i18n.t("ui.permission.allowOnce")}</button>
              </form>
            </Show>
          </>
        )}
      </Show>
      <Show when={view()}>
        {(result) => (
          <FlightWidget
            view={result()}
            label="Flight results"
            actions={{
              widget: FlightAction.widget,
              disabled: !!pending(),
              run: (operation) => {
                const request = FlightAction.reschedule(result(), operation)

                if (!request) {
                  setStatus("This action is unavailable.")

                  return
                }

                setStatus("")
                setPending(request)
              },
            }}
          />
        )}
      </Show>
    </>
  )
}

const root = document.getElementById("flight-search")

if (root) render(() => <Demo />, root)
