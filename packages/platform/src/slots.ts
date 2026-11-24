
import { defineComponent, type Component } from "@weft-framework/runtime";

export interface SlotSpec {
  description?: string;
  max?: number;
  kind?: "component" | "link" | "both";
}

export interface Contribution<V = unknown, P extends object = Record<string, unknown>> {
  id: string;
  slot: string;
  order?: number;
  title?: string;
  icon?: string;
  href?: string | ((props: P) => string);
  component?: Component<P & { viewer: V }>;
  permission?: string;
  when?(viewer: V, props: P): boolean;
  plugin?: string;
}

export interface SlotEntry<V, P extends object> extends Contribution<V, P> {
  order: number;
  link: string | null;
}

export interface SlotRegistryOptions<V> {
  slots: Readonly<Record<string, SlotSpec>>;
  can(viewer: V, permission: string, props: object): boolean;
  enabled?(plugin: string): boolean;
  onError?(err: unknown, entry: { slot: string; id: string; plugin?: string }): void;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SLOT_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;

export class SlotError extends Error {}

export class SlotRegistry<V> {
  readonly #slots: ReadonlyMap<string, SlotSpec>;
  readonly #entries = new Map<string, Map<string, Contribution<V, any>>>();
  readonly #o: SlotRegistryOptions<V>;
  readonly #listeners = new Set<() => void>();

  constructor(o: SlotRegistryOptions<V>) {
    const slots = new Map<string, SlotSpec>();
    for (const [name, spec] of Object.entries(o.slots)) {
      if (!SLOT_RE.test(name)) throw new SlotError(`slot \`${name}\`: names look like \`area.place\` (lower-case, dotted)`);
      if (spec.max !== undefined && (!Number.isInteger(spec.max) || spec.max < 1)) throw new SlotError(`slot \`${name}\`: max is a positive integer`);
      slots.set(name, Object.freeze({ kind: "both", ...spec }));
      this.#entries.set(name, new Map());
    }
    this.#slots = slots;
    this.#o = o;
  }

  get slots(): readonly string[] {
    return [...this.#slots.keys()];
  }

  spec(slot: string): SlotSpec | undefined {
    return this.#slots.get(slot);
  }

  contribute<P extends object>(c: Contribution<V, P>): () => void {
    const spec = this.#slots.get(c.slot);
    if (!spec) throw new SlotError(`no slot \`${c.slot}\``);
    if (typeof c.id !== "string" || !ID_RE.test(c.id)) throw new SlotError(`slot \`${c.slot}\`: entry id \`${String(c.id)}\` is lower-case letters, digits, . _ -`);
    const map = this.#entries.get(c.slot)!;
    if (map.has(c.id)) throw new SlotError(`slot \`${c.slot}\` already has \`${c.id}\``);
    if (c.order !== undefined && !Number.isFinite(c.order)) throw new SlotError(`slot \`${c.slot}\`/${c.id}: order is a number`);
    if (spec.kind === "component" && !c.component) throw new SlotError(`slot \`${c.slot}\` renders components; \`${c.id}\` has none`);
    if (spec.kind === "link" && c.href === undefined) throw new SlotError(`slot \`${c.slot}\` holds links; \`${c.id}\` has no href`);
    if (c.component !== undefined && typeof c.component !== "function") throw new SlotError(`slot \`${c.slot}\`/${c.id}: component is a Weft component`);
    const entry = Object.freeze({ ...c });
    map.set(c.id, entry);
    this.#changed();
    return () => {
      if (map.get(c.id) === entry) {
        map.delete(c.id);
        this.#changed();
      }
    };
  }

  defineSlot(name: string, spec: SlotSpec = {}): void {
    if (this.#slots.has(name)) throw new SlotError(`slot \`${name}\` exists`);
    if (!SLOT_RE.test(name)) throw new SlotError(`slot \`${name}\`: names look like \`area.place\``);
    (this.#slots as Map<string, SlotSpec>).set(name, Object.freeze({ kind: "both", ...spec }));
    this.#entries.set(name, new Map());
  }

  removePlugin(plugin: string): number {
    let n = 0;
    for (const map of this.#entries.values()) {
      for (const [id, e] of map) {
        if (e.plugin === plugin) {
          map.delete(id);
          n++;
        }
      }
    }
    if (n) this.#changed();
    return n;
  }

  entries<P extends object>(slot: string, viewer: V, props: P = {} as P): SlotEntry<V, P>[] {
    const spec = this.#slots.get(slot);
    if (!spec) throw new SlotError(`no slot \`${slot}\``);
    const out: SlotEntry<V, P>[] = [];
    for (const e of this.#entries.get(slot)!.values()) {
      try {
        if (e.plugin !== undefined && this.#o.enabled && !this.#o.enabled(e.plugin)) continue;
        if (e.permission !== undefined && !this.#o.can(viewer, e.permission, props)) continue;
        if (e.when && e.when(viewer, props) !== true) continue;
        const link = e.href === undefined ? null : typeof e.href === "function" ? e.href(props) : e.href;
        out.push({ ...(e as Contribution<V, P>), order: e.order ?? 100, link });
      } catch (err) {
        this.#report(err, slot, e);
      }
    }
    out.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return spec.max === undefined ? out : out.slice(0, spec.max);
  }

  render<P extends object>(slot: string, viewer: V, props: P = {} as P): string {
    let html = "";
    for (const e of this.entries(slot, viewer, props)) {
      if (!e.component) continue;
      try {
        html += e.component({ ...props, viewer } as P & { viewer: V });
      } catch (err) {
        this.#report(err, slot, e);
      }
    }
    return html;
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #changed(): void {
    for (const fn of this.#listeners) {
      try {
        fn();
      } catch {
      }
    }
  }

  #report(err: unknown, slot: string, e: Contribution<V, any>): void {
    try {
      this.#o.onError?.(err, { slot, id: e.id, ...(e.plugin ? { plugin: e.plugin } : {}) });
    } catch {
    }
  }
}

export function defineSlots<V>(o: SlotRegistryOptions<V>): SlotRegistry<V> {
  return new SlotRegistry<V>(o);
}

export const Slot = defineComponent("KitSlot", (p: { registry: SlotRegistry<any>; name: string; viewer: unknown; props?: object }) => ({
  handlers: {},
  render: () => p.registry.render(p.name, p.viewer, p.props ?? {}),
}));

export const COMMON_SLOTS = {
  "admin.nav": { kind: "link", description: "Staff app sidebar" },
  "client.nav": { kind: "link", description: "Customer app sidebar" },
  "account.sections": { kind: "both", description: "Account settings sections" },
  "dashboard.widgets": { kind: "component", description: "Widgets offered on dashboards (see widgets.ts)" },
  "admin.settings": { kind: "both", description: "Extra settings pages" },
  "auth.login": { kind: "component", description: "Blocks under the sign-in form (SSO buttons, notices)" },
  "page.head": { kind: "component", description: "Extra head markup (admin-gated)" },
} as const satisfies Record<string, SlotSpec>;
