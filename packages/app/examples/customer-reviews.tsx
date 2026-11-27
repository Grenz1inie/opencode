import { CustomerReviews } from "@opencode/flight-action"
import { ActionWidget, renderActionWidget } from "@opencode/session-ui/action-widget"
import { createMemo, createSignal, Show } from "solid-js"
import { render } from "solid-js/web"

function Demo() {
  const [empty, setEmpty] = createSignal(false)
  const result = createMemo(() => {
    const output = CustomerReviews.run({ empty: empty() }).metadata.actionOutput
    return renderActionWidget(CustomerReviews.widget, output.outputs)
  })

  return (
    <>
      <h1>Pronto review widget</h1>
      <nav aria-label="Sample data">
        <button aria-pressed={!empty()} onClick={() => setEmpty(false)}>Two reviews</button>
        <button aria-pressed={empty()} onClick={() => setEmpty(true)}>Empty list</button>
      </nav>
      <Show when={result().tree} fallback={<p role="status">{result().diagnostic}</p>}>
        {(tree) => <ActionWidget tree={tree()} label="Customer reviews" />}
      </Show>
    </>
  )
}

const root = document.getElementById("pronto-reviews")
if (root) render(() => <Demo />, root)
