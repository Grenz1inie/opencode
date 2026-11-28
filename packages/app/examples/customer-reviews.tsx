import { CustomerReviews } from "@opencode/flight-action"
import { ActionWidget, renderActionWidget } from "@opencode/session-ui/action-widget"
import { createMemo, createSignal, Show } from "solid-js"
import { render } from "solid-js/web"

function Demo() {
  const [empty, setEmpty] = createSignal(false)
  const [wrapped, setWrapped] = createSignal(false)

  const result = createMemo(() => {
    const reviews = CustomerReviews.sample(empty())

    if (!wrapped()) return renderActionWidget(CustomerReviews.widget, { reviews })

    const parsed = CustomerReviews.invocable({
      actionName: "GetCustomerReviewsAction",
      isSuccess: true,
      outputValues: { isSuccess: true, reviews },
    })

    if ("diagnostic" in parsed) return { tree: undefined, diagnostic: parsed.diagnostic.path }

    return renderActionWidget(CustomerReviews.widget, { reviews: parsed.reviews })
  })

  return (
    <>
      <h1>Pronto review widget</h1>
      <nav aria-label="Result format">
        <button aria-pressed={!wrapped()} onClick={() => setWrapped(false)}>Direct result</button>
        <button aria-pressed={wrapped()} onClick={() => setWrapped(true)}>Invocable result</button>
      </nav>
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
