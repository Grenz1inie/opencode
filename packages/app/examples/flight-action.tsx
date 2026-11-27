import { FlightAction } from "@opencode/flight-action"
import { FlightWidget } from "@opencode/session-ui/flight-widget"
import { createSignal, For, Show } from "solid-js"
import { render } from "solid-js/web"

function Demo() {
  const [view, setView] = createSignal<FlightAction.View>()
  const [status, setStatus] = createSignal("")
  const [pending, setPending] = createSignal<ReturnType<typeof FlightAction.prepare>>()
  const [draft, setDraft] = createSignal({
    originCity: "杭州",
    destinationCity: "成都",
    dateOfTravel: "2026-12-05",
  })

  function search(input: unknown) {
    const result = FlightAction.run(input)
    console.debug("Flight search target invoked", result.tool.content)
    setView(result.user)
    setPending(undefined)
    setStatus("")
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
              setView(undefined)
              const prepared = FlightAction.prepare(next)
              if (prepared.fields.length === 0) search(prepared.values)
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
              if (FlightAction.prepare(next).fields.length > 0) {
                setStatus("Enter all required flight details.")
                return
              }
              search(next)
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
