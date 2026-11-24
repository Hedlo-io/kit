
import type { Component } from "@weft-framework/runtime";
import { settingProblem, type SettingsSchema } from "@weft-framework/server/settings";

export interface WidgetSize {
  w: number;
  h: number;
}

export interface WidgetProps<V> {
  viewer: V;
  settings: Record<string, boolean | number | string>;
  size: WidgetSize;
  context: Record<string, unknown>;
}

export interface WidgetDef<V = unknown> {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  sizes: readonly WidgetSize[];
  settings?: SettingsSchema;
  permission?: string;
  dashboards?: readonly string[];
  component: Component<WidgetProps<V>>;
  plugin?: string;
}

export interface WidgetRegistryOptions<V> {
  can(viewer: V, permission: string, context: Record<string, unknown>): boolean;
  enabled?(plugin: string): boolean;
}

export class WidgetError extends Error {}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export const MAX_CELLS = 24;

export class WidgetRegistry<V> {
  readonly #defs = new Map<string, WidgetDef<V>>();
  readonly #o: WidgetRegistryOptions<V>;

  constructor(o: WidgetRegistryOptions<V>) {
    this.#o = o;
  }

  register(def: WidgetDef<V>): () => void {
    if (!ID_RE.test(def.id ?? "")) throw new WidgetError(`widget id \`${String(def.id)}\` is lower-case letters, digits, . _ -`);
    if (this.#defs.has(def.id)) throw new WidgetError(`widget \`${def.id}\` is registered`);
    if (!Array.isArray(def.sizes) || def.sizes.length === 0) throw new WidgetError(`widget \`${def.id}\`: at least one size`);
    for (const s of def.sizes) {
      if (!Number.isInteger(s.w) || !Number.isInteger(s.h) || s.w < 1 || s.h < 1 || s.w > MAX_CELLS || s.h > MAX_CELLS) {
        throw new WidgetError(`widget \`${def.id}\`: sizes are 1–${MAX_CELLS} cells`);
      }
    }
    if (typeof def.component !== "function") throw new WidgetError(`widget \`${def.id}\`: component is a Weft component`);
    for (const [k, spec] of Object.entries(def.settings ?? {})) {
      const p = settingProblem(spec, spec.default);
      if (p) throw new WidgetError(`widget \`${def.id}\`: default of \`${k}\`: ${p}`);
    }
    const frozen = Object.freeze({ ...def, sizes: Object.freeze(def.sizes.map((s) => Object.freeze({ ...s }))) });
    this.#defs.set(def.id, frozen);
    return () => {
      if (this.#defs.get(def.id) === frozen) this.#defs.delete(def.id);
    };
  }

  removePlugin(plugin: string): number {
    let n = 0;
    for (const [id, d] of this.#defs) if (d.plugin === plugin && this.#defs.delete(id)) n++;
    return n;
  }

  get(id: string): WidgetDef<V> | undefined {
    const d = this.#defs.get(id);
    if (!d) return undefined;
    if (d.plugin !== undefined && this.#o.enabled && !this.#o.enabled(d.plugin)) return undefined;
    return d;
  }

  allowed(def: WidgetDef<V>, viewer: V, dashboard: string, context: Record<string, unknown> = {}): boolean {
    if (def.dashboards && !def.dashboards.includes(dashboard)) return false;
    try {
      return def.permission === undefined || this.#o.can(viewer, def.permission, context) === true;
    } catch {
      return false;
    }
  }

  available(viewer: V, dashboard: string, context: Record<string, unknown> = {}): WidgetDef<V>[] {
    return [...this.#defs.keys()]
      .map((id) => this.get(id))
      .filter((d): d is WidgetDef<V> => d !== undefined && this.allowed(d, viewer, dashboard, context))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  settings(def: WidgetDef<V>, raw: Record<string, unknown> | undefined): Record<string, boolean | number | string> {
    const out: Record<string, boolean | number | string> = {};
    for (const [k, spec] of Object.entries(def.settings ?? {})) {
      const v = raw && Object.hasOwn(raw, k) ? raw[k] : spec.default;
      const p = settingProblem(spec, v);
      if (p) throw new WidgetError(`widget \`${def.id}\` setting \`${k}\`: ${p}`);
      out[k] = v as boolean | number | string;
    }
    return out;
  }

  fits(def: WidgetDef<V>, size: WidgetSize): boolean {
    return def.sizes.some((s) => s.w === size.w && s.h === size.h);
  }
}

export function defineWidgets<V>(o: WidgetRegistryOptions<V>): WidgetRegistry<V> {
  return new WidgetRegistry<V>(o);
}
