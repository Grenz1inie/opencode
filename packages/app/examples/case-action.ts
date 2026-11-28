import { CaseAction, type LightningEditor } from "@opencode/flight-action"

function control(field: LightningEditor.Field, multiline: boolean) {
  if (field.options) {
    const select = document.createElement("select")

    select.add(new Option("Select priority", ""))
    field.options.forEach((item) => select.add(new Option(item.label, item.value)))

    return select
  }

  if (multiline) return document.createElement("textarea")

  const input = document.createElement("input")

  input.type = field.format ?? "text"

  if (field.pattern) input.pattern = field.pattern

  return input
}

const form = document.querySelector<HTMLFormElement>("#case-form")

const fields = document.querySelector<HTMLElement>("#fields")

const status = document.querySelector<HTMLElement>("#status")

const result = document.querySelector<HTMLElement>("#result")

const open = document.querySelector<HTMLButtonElement>("#open")

const cancel = document.querySelector<HTMLButtonElement>("#cancel")

if (form && fields && status && result && open && cancel) {
  const plan = CaseAction.prepare({})

  if (plan.kind === "unavailable") {
    form.hidden = true
    status.setAttribute("role", "alert")
    status.textContent = plan.message
  }

  if (plan.kind !== "unavailable") {
    for (const field of plan.fields) {
      const label = document.createElement("label")
      const input = control(field, plan.kind === "registered" && field.key === CaseAction.description)

      input.name = field.key
      input.required = field.required
      input.value = field.default ?? ""
      label.append(field.title, input)
      fields.append(label)
    }

    const dismiss = () => {
      form.hidden = true
      status.textContent = "Case submission cancelled."
      open.hidden = false
      open.focus()
    }

    cancel.addEventListener("click", dismiss)
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape") dismiss()
    })
    form.addEventListener("submit", (event) => {
      event.preventDefault()

      if (form.hidden) return

      const answer = Object.fromEntries([...new FormData(form)].filter((entry) => entry[1] !== ""))
      const input = CaseAction.fromAnswer(answer)
      const completed = CaseAction.run(input)

      console.debug("Simulated case target invoked")
      result.textContent = JSON.stringify(completed.metadata.actionOutput.outputs, null, 2)
      result.hidden = false
      status.textContent = "Simulated case recorded."
      form.hidden = true
      open.hidden = false
      open.focus()
    })
    open.addEventListener("click", () => {
      result.hidden = true
      status.textContent = ""
      open.hidden = true
      form.reset()
      form.hidden = false
      form.querySelector("input")?.focus()
    })
  }
}
