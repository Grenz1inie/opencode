import type { Tool } from "@opencode/schema/tool"
import type { WidgetResource } from "@opencode/schema/widget-resource"
import type { Effect, Schema, Scope } from "effect"
import type { Registration } from "./effect/registration.js"

type Field = { readonly type: string }

export interface Definition {
  readonly name: string
  readonly description: string
  readonly target: string
  readonly widget?: string
  readonly inputs: Readonly<Record<string, Field & { readonly is_required?: boolean }>>
  readonly outputs: Readonly<
    Record<string, Field & { readonly is_displayable?: boolean; readonly filter_from_agent?: boolean }>
  >
}

export type Target = (input: Schema.JsonObject, context: Tool.Context) => Effect.Effect<unknown, Tool.Error>

export interface Catalog {
  readonly actions: readonly Definition[]
  readonly targets: Readonly<Record<string, Target>>
  readonly types: Readonly<Record<string, Schema.Codec<Schema.Json, Schema.Json>>>
  readonly widgets?: Readonly<Record<string, WidgetResource.Definition>>
}

export interface ExperimentalActionDomain {
  /** Adds the catalog to this Location for the lifetime of the plugin's scope. */
  readonly register: (catalog: Catalog) => Effect.Effect<Registration, never, Scope.Scope>
}
