import { defineAccess, type AccessConfig, type AccessControl, type PermissionInfo, type RoleConfig, type ScopeInfo, type ScopeTypeConfig, type SettingsConfig } from "@weft-framework/core";

export const SYSTEM_USER = "system";

export const KIT_PERMISSIONS = {
  "platform.manage": "Change platform-wide configuration",
  "plugins.manage": "Install, enable and configure plugins",
  "branding.manage": "Change themes, logos and product names",
  "branding.code": "Add custom CSS and head tags",
  "content.manage": "Edit content blocks and custom pages",
  "translations.manage": "Override translations",
  "emails.manage": "Edit email templates",
  "announcements.manage": "Publish announcements and banners",
  "layouts.manage": "Change default dashboards and navigation",
  "audit.read": "Read the audit log",
  "users.read": "See user accounts",
  "users.manage": "Create, lock and change user accounts",
  "users.impersonate": "Sign in as another user (audited)",
  "resellers.manage": "Create and manage resellers",
  "customers.read": "See customers",
  "customers.manage": "Create and manage customers",
  "jobs.manage": "See and retry background jobs",
  "webhooks.manage": "Configure outgoing webhooks",
  "gdpr.manage": "Export and erase personal data on request",
} as const;

export type KitPermission = keyof typeof KIT_PERMISSIONS;

const MANAGE_ACCESS = ["access.members.read", "access.members.manage", "access.roles.manage", "access.permissions.manage", "access.scopes.manage", "access.settings.manage"] as const;
const TENANT_ADMIN = ["branding.manage", "content.manage", "translations.manage", "emails.manage", "announcements.manage", "layouts.manage", "audit.read", "customers.read", "customers.manage", "users.read", ...MANAGE_ACCESS] as const;

export const KIT_SCOPES = {
  platform: { label: "Platform" },
  reseller: { parent: "platform", label: "Reseller" },
  customer: { parent: ["platform", "reseller"], label: "Customer" },
} as const satisfies Record<string, ScopeTypeConfig>;

export const STAFF_ROLES = ["owner", "admin", "support"] as const;

export const KIT_ROLES = {
  owner: { scope: "platform", permissions: ["*"], label: "Owner" },
  admin: {
    scope: "platform",
    label: "Administrator",
    permissions: ["platform.manage", "plugins.manage", "branding.code", "resellers.manage", "users.manage", "users.impersonate", "jobs.manage", "webhooks.manage", "gdpr.manage", ...TENANT_ADMIN],
  },
  support: { scope: "platform", label: "Support", permissions: ["users.read", "customers.read", "audit.read", "users.impersonate", "access.members.read"] },
  reseller_owner: { scope: "reseller", label: "Reseller owner", permissions: [...TENANT_ADMIN, "webhooks.manage"] },
  reseller_staff: { scope: "reseller", label: "Reseller staff", permissions: ["customers.read", "users.read", "audit.read", "access.members.read"] },
  customer_owner: { scope: "customer", label: "Customer owner", permissions: ["access.members.read", "access.members.manage", "access.scopes.manage", "audit.read"] },
  customer_member: { scope: "customer", label: "Member", permissions: ["access.members.read"] },
} as const;

export interface KitAccessInput<P extends string, R extends string, S extends string, T extends SettingsConfig> {
  scopes?: { readonly [K in S]: ScopeTypeConfig<string> };
  permissions?: { readonly [K in P]: string | PermissionInfo };
  roles?: { readonly [K in R]: RoleConfig<string, string, string> };
  extend?: Partial<Record<keyof typeof KIT_ROLES, readonly string[]>>;
  settings?: T;
  seats?: string;
  custom?: AccessConfig<string, string, string, T>["custom"];
  invites?: AccessConfig<string, string, string, T>["invites"];
  prefix?: string;
  now?(): number;
}

export class KitAccessError extends Error {}

export function kitAccessConfig<P extends string = never, R extends string = never, S extends string = never, T extends SettingsConfig = {}>(
  input: KitAccessInput<P, R, S, T> = {},
): AccessConfig<string, string, string, T> {
  for (const k of Object.keys(input.permissions ?? {})) if (k in KIT_PERMISSIONS) throw new KitAccessError(`permission \`${k}\` is defined by kit`);
  for (const k of Object.keys(input.roles ?? {})) if (k in KIT_ROLES) throw new KitAccessError(`role \`${k}\` is defined by kit; use extend`);
  for (const k of Object.keys(input.scopes ?? {})) if (k in KIT_SCOPES) throw new KitAccessError(`scope \`${k}\` is defined by kit`);
  const roles: Record<string, RoleConfig<string, string, string>> = {};
  for (const [k, r] of Object.entries(KIT_ROLES) as [keyof typeof KIT_ROLES, RoleConfig][]) {
    const extra = input.extend?.[k] ?? [];
    roles[k] = { ...r, permissions: [...new Set([...(r.permissions ?? []), ...extra])] };
  }
  Object.assign(roles, input.roles ?? {});
  return {
    scopes: { ...KIT_SCOPES, ...(input.scopes ?? {}) },
    permissions: { ...KIT_PERMISSIONS, ...(input.permissions ?? {}) },
    roles,
    owner: "owner",
    custom: input.custom ?? { roles: { max: 20 }, permissions: { max: 50 } },
    ...(input.settings ? { settings: input.settings } : {}),
    ...(input.seats ? { seats: input.seats as never } : {}),
    ...(input.invites ? { invites: input.invites } : {}),
    ...(input.prefix ? { prefix: input.prefix } : {}),
    ...(input.now ? { now: input.now } : {}),
    canCreateTenant: (user) => user === SYSTEM_USER,
  } as AccessConfig<string, string, string, T>;
}

export function defineKitAccess<P extends string = never, R extends string = never, S extends string = never, T extends SettingsConfig = {}>(input: KitAccessInput<P, R, S, T> = {}): AccessControl<string, string, string, T> {
  return defineAccess(kitAccessConfig(input) as AccessConfig<string, string, string, T>) as AccessControl<string, string, string, T>;
}

export interface Viewer {
  id: string;
  scope: string;
  impersonator?: string | null;
}

export interface Guards {
  userId(v: Viewer): string | null;
  tenantOf(v: Viewer): string | null;
  parentTenant(scope: string): string | null;
  scopeType(scope: string): string | null;
  can(v: Viewer, permission: string, scope?: string): boolean;
  canManage(perm: string): (v: Viewer, scope: string) => boolean;
  isStaff(user: string): boolean;
  rolesOf(v: Viewer): string[];
  canImpersonate(staff: Viewer, target: string): boolean;
  platform(): string;
}

export function kitGuards(access: AccessControl<string, string, string, any>, platformScope: string): Guards {
  const info = (scope: string): ScopeInfo | null => {
    try {
      return access.scope(SYSTEM_USER, scope);
    } catch {
      return null;
    }
  };
  const allows = (user: string, perm: string, scope: string) => {
    try {
      return access.allows(user, perm, scope);
    } catch {
      return false;
    }
  };
  const isStaff = (user: string) => user !== SYSTEM_USER && access.members(SYSTEM_USER, platformScope).some((m) => m.user === user && m.scope === platformScope);
  const roleScopes = (user: string, scope: string) => {
    const out: string[] = [];
    for (let s: ScopeInfo | null = info(scope); s; s = s.parent ? info(s.parent) : null) {
      for (const m of access.members(SYSTEM_USER, s.id)) if (m.user === user && m.scope === s.id) out.push(m.role);
    }
    return out;
  };
  return {
    userId: (v) => (v && typeof v.id === "string" && v.id !== SYSTEM_USER ? v.id : null),
    tenantOf: (v) => (v && info(v.scope) ? v.scope : null),
    parentTenant: (scope) => info(scope)?.parent ?? null,
    scopeType: (scope) => info(scope)?.type ?? null,
    can: (v, permission, scope) => !!v && v.id !== SYSTEM_USER && allows(v.id, permission, scope ?? v.scope),
    canManage: (perm) => (v, scope) => !!v && v.id !== SYSTEM_USER && !v.impersonator && allows(v.id, perm, scope),
    isStaff,
    rolesOf: (v) => (v ? [...new Set(roleScopes(v.id, v.scope))].sort() : []),
    canImpersonate: (staff, target) => {
      if (!staff || staff.impersonator || staff.id === target || target === SYSTEM_USER) return false;
      if (!allows(staff.id, "users.impersonate", platformScope)) return false;
      if (!isStaff(target)) return true;
      return roleScopes(staff.id, platformScope).includes("owner") && !roleScopes(target, platformScope).includes("owner");
    },
    platform: () => platformScope,
  };
}

export async function bootstrapPlatform(access: AccessControl<string, string, string, any>, opts: { name: string; owner: string }): Promise<{ platform: string }> {
  const existing = access.tenantsOf(SYSTEM_USER).find((t) => t.type === "platform");
  const platform = existing ?? (await access.createTenant(SYSTEM_USER, { name: opts.name, type: "platform" }));
  if (!access.members(SYSTEM_USER, platform.id).some((m) => m.user === opts.owner && m.role === "owner")) {
    await access.assign(SYSTEM_USER, { user: opts.owner, role: "owner", scope: platform.id });
  }
  return { platform: platform.id };
}
