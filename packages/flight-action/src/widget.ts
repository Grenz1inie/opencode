export * as Widget from "./widget.js"

import type { WidgetResource } from "@opencode/schema/widget-resource"
import { Option, Schema } from "effect"

export type Node = WidgetResource.Node

export type Rendered = {
  definition: Node["definition"]
  id?: string
  attributes: Node["attributes"]
  text?: string
  repeated: boolean
  children: readonly Rendered[]
}

type Scope = Readonly<Record<string, unknown>>
const pathToken = /^\{!(\$\w+(?:\.\w+)+)\}$/
const textAttributes: Readonly<Record<string, readonly string[]>> = {
  "tile/widget": [],
  "tile/column": ["gap"],
  "tile/row": ["gap", "justify", "align"],
  "tile/text": ["text", "variant", "color", "weight"],
  "tile/icon": ["name", "alt"],
  "tile/separator": [],
  "tile/button": ["label"],
}

export type Operation = { widget: string; node: string; definition: string }

const click = Schema.decodeUnknownOption(
  Schema.Struct({
    click: Schema.Array(Schema.Struct({
      definition: Schema.String,
      attributes: Schema.Struct({ content: Schema.String }),
    })),
  }),
)

export function operation(widget: string, node: Rendered): Operation | undefined {
  if (node.definition !== "tile/button" || !node.id) return
  const actions = Option.getOrUndefined(click(node.attributes?.actions))?.click
  if (actions?.length !== 1 || !actions[0]) return
  return { widget, node: node.id, definition: actions[0].definition }
}

export class BindingError extends Error {
  constructor(readonly resource: string, readonly path: string, reason: string) {
    super(`${resource} · ${path}: ${reason}`)
  }
}

// The supported expression language only reads own properties of the JSON payload.
export function bind(expression: string, scope: Scope) {
  const path = pathToken.exec(expression)?.[1]?.split(".")
  if (!path) throw new Error("Unsupported binding expression")
  const root = path[0]!
  if (!Object.hasOwn(scope, root)) throw new Error("Unknown binding scope")
  return path.slice(1).reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined
    // SAFETY: the key was checked on the JSON payload or Solid store proxy.
    return (value as Scope)[key]
  }, scope[root])
}

export function render(resource: string, node: Node, attributes: Scope): Rendered {
  const elements = expand(resource, node, { $attrs: attributes }, "$")
  return elements[0] ?? { definition: "tile/widget", attributes: undefined, repeated: false, children: [] }
}

function expand(resource: string, node: Node, scope: Scope, path: string): Rendered[] {
  const keys = Object.hasOwn(textAttributes, node.definition) ? textAttributes[node.definition] : undefined
  if (!keys) throw new BindingError(resource, path + ".definition", "Unsupported tile")
  for (const key of keys) {
    const value = node.attributes?.[key]
    if (value !== undefined && typeof value !== "string") {
      throw new BindingError(resource, path + ".attributes." + key, "Expected a string")
    }
  }
  const scopes = node.meta?.forEach === undefined
    ? [scope]
    : (() => {
        const list = resolve(resource, path + ".meta.forEach", node.meta.forEach, scope)
        if (!Array.isArray(list)) throw new BindingError(resource, path + ".meta.forEach", "Expected a list")
        return list.map((value: unknown) => ({ ...scope, [node.meta?.forItem ?? "$Item"]: value }))
      })()
  return scopes.flatMap((current) => {
    if (node.meta?.if !== undefined) {
      const test = resolve(resource, path + ".meta.if", node.meta.if, current)
      if (test === false || test == null) return []
      if (test !== true) throw new BindingError(resource, path + ".meta.if", "Expected a boolean")
    }
    const text = node.attributes?.text
    return [{
      definition: node.definition,
      ...(node.id ? { id: node.id } : {}),
      attributes: node.attributes,
      text: typeof text === "string" ? interpolate(resource, path + ".attributes.text", text, current) : undefined,
      repeated: node.meta?.forEach !== undefined,
      children: (node.children ?? []).flatMap((child, index) => expand(resource, child, current, `${path}.children[${index}]`)),
    }]
  })
}

function resolve(resource: string, path: string, expression: string, scope: Scope) {
  try {
    return bind(expression, scope)
  } catch (error) {
    throw new BindingError(resource, path, error instanceof Error ? error.message : "Invalid binding")
  }
}

function interpolate(resource: string, path: string, input: string, scope: Scope) {
  const replaced = input.replace(/\{![^}]+\}/g, (token) => {
    const value = resolve(resource, path, token, scope)
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new BindingError(resource, path, "Expected a scalar value")
    }
    return String(value)
  })
  if (input.replace(/\{![^}]+\}/g, "").includes("{!")) {
    throw new BindingError(resource, path, "Unclosed binding")
  }
  return replaced
}
