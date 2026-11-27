import { FlightAction } from "@opencode/flight-action"
import { FlightWidget } from "@opencode/session-ui/flight-widget"
import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"

function Demo() {
  const [view, setView] = createSignal<FlightAction.View>()
  const [status, setStatus] = createSignal("")
  return (
    <>
      <h1>Simulated flight search</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const input = Object.fromEntries(new FormData(event.currentTarget))
          try {
            setView(FlightAction.run(input).user)
            setStatus("")
          } catch {
            setView(undefined)
            setStatus("Enter two cities and a valid date to search for flights.")
          }
        }}
      >
        <label>
          Origin city
          <input name="originCity" value="杭州" required />
        </label>
        <label>
          Destination city
          <input name="destinationCity" value="成都" required />
        </label>
        <label>
          Departure date
          <input name="dateOfTravel" type="date" value="2026-12-05" required />
        </label>
        <button type="submit">Find flights</button>
      </form>
      <div role="status">{status()}</div>
      <Show when={view()}>{(result) => <FlightWidget view={result()} label="Flight results" />}</Show>
    </>
  )
}

const root = document.getElementById("flight-search")
if (root) render(() => <Demo />, root)
