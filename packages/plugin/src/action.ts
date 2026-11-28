import type { Tool } from "@opencode/schema/tool"
import type { WidgetResource } from "@opencode/schema/widget-resource"
import type { Effect, Schema, Scope } from "effect"
import type { Registration } from "./effect/registration.js"

type Field = { readonly type: string }

export interface InputField extends Field {
  readonly title?: string
  readonly is_required?: boolean
  readonly is_user_input?: boolean
}

export interface EditorField {
  readonly path: readonly [string, ...string[]]
  readonly type: "lightning__textType" | "lightning__dateType"
  readonly title: string
  readonly required?: boolean
}

export interface Editor {
  readonly definition: string
  readonly title: string
  readonly fields: readonly [EditorField, ...EditorField[]]
}

export interface Definition {
  readonly name: string
  readonly description: string
  readonly target: string
  readonly widget?: string
  readonly inputs: Readonly<Record<string, InputField>>
  readonly outputs: Readonly<
    Record<string, Field & { readonly is_displayable?: boolean; readonly filter_from_agent?: boolean }>
  >
}

export type Target = (input: Schema.JsonObject, context: Tool.Context) => Effect.Effect<unknown, Tool.Error>

export interface Catalog {
  readonly actions: readonly Definition[]
  readonly targets: Readonly<Record<string, Target>>
  readonly types: Readonly<Record<string, Schema.Codec<Schema.Json, Schema.Json>>>
  /** Editors keyed by input type and then by channel, such as `lightningDesktopGenAi`. */
  readonly editors?: Readonly<Record<string, Readonly<Record<string, Editor>>>>
  readonly widgets?: Readonly<Record<string, WidgetResource.Definition>>
}

export interface ExperimentalActionDomain {
  /** Adds the catalog to this Location for the lifetime of the plugin's scope. */
  readonly register: (catalog: Catalog) => Effect.Effect<Registration, never, Scope.Scope>
}
