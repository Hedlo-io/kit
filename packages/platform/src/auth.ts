import type { PgPool } from "@weft-framework/data/postgres";
import {
  defineAccount,
  definePasskeys,
  defineTwoFactor,
  emailSignIn,
  stopViewingAs,
  viewAs,
  viewingAs,
  type Identity,
  type PageContext,
  type Provider,
  type Secret,
} from "@weft-framework/server";
import { PgAccountTokenStore, PgEmailTokenStore, PgPasskeyStore, PgSessionStore, PgTwoFactorStore } from "@weft-framework/server/pg-stores";
import { defineSaml, type SamlConnection, type SamlReplayStore } from "@weft-framework/server/saml";
import type { Activity } from "./activity.ts";
import type { EmailDef } from "./emails.ts";

export type Maybe<T> = T | Promise<T>;

export interface KitUser {
  id: string;
  email: string;
}

export interface KitUserDirectory {
  byEmail(email: string): Maybe<KitUser | null>;
  byId(id: string): Maybe<KitUser | null>;
  create(email: string, passwordHash: string | null): Maybe<string>;
  setPassword(id: string, hash: string): Maybe<void>;
  setEmail(id: string, email: string): Maybe<void>;
  markVerified(id: string, email: string): Maybe<void>;
  byIdentity?(identity: Identity): Maybe<string | null>;
}

export type KitMailKey = (typeof KIT_AUTH_EMAILS)[number]["key"];

export type KitMailer = (key: KitMailKey, to: string, values: Record<string, string | number>) => Maybe<void>;

export interface KitAuthPages {
  signIn: string;
  signUp: string;
  emailSignIn: string;
  twoFactor: string;
  reset: string;
  verify: string;
  email: string;
}

export const DEFAULT_KIT_AUTH_PAGES: KitAuthPages = {
  signIn: "/sign-in",
  signUp: "/sign-up/confirm",
  emailSignIn: "/sign-in/confirm",
  twoFactor: "/sign-in/two-factor",
  reset: "/reset-password",
  verify: "/verify-email",
  email: "/account/email",
};

export interface KitAuthOptions {
  pool: PgPool;
  prefix: string;
  url: string;
  name: string;
  key: Secret | string;
  users: KitUserDirectory;
  mail: KitMailer;
  activity: Activity<unknown>;
  auditScope: (user: string | null) => string;
  allowSignUp?: (email: string, ctx: PageContext) => Maybe<boolean | string>;
  requireTwoFactor?: (user: string, tenant?: string) => Maybe<boolean>;
  canImpersonate: (operator: string, target: string, tenant?: string) => Maybe<boolean>;
  providers?: Provider[];
  saml?: (id: string) => Maybe<SamlConnection | null | undefined>;
  pages?: Partial<KitAuthPages>;
  minPasswordLength?: number;
  maxImpersonationMinutes?: number;
  now?: () => number;
}

export class KitAuthError extends Error {
  readonly code: "forbidden" | "invalid";
  constructor(code: "forbidden" | "invalid", message: string) {
    super(message);
    this.code = code;
    this.name = "KitAuthError";
  }
}

const PREFIX = /^[a-z][a-z0-9_]{0,30}_$/;

const LINK = { link: { kind: "url" as const }, expires: { kind: "date" as const } };

export const KIT_AUTH_EMAILS = [
  {
    key: "auth.password-reset",
    title: "Password reset",
    variables: { product: { kind: "string" }, ...LINK },
    subject: "Reset your {{product}} password",
    body: "Someone asked to reset the password for this address.\n\n[Choose a new password]({{link}})\n\nThe link works once until {{expires}}. If this was not you, ignore this email.",
  },
  {
    key: "auth.password-changed",
    title: "Password changed",
    variables: { product: { kind: "string" } },
    subject: "Your {{product}} password was changed",
    body: "Your password was just changed. If this was not you, reset it now and contact support.",
  },
  {
    key: "auth.email-change",
    title: "Confirm new email",
    variables: { product: { kind: "string" }, ...LINK },
    subject: "Confirm your new {{product}} email",
    body: "[Confirm this address]({{link}})\n\nThe link works until {{expires}}.",
  },
  {
    key: "auth.email-changed",
    title: "Email changed",
    variables: { product: { kind: "string" }, newEmail: { kind: "string" } },
    subject: "Your {{product}} email was changed",
    body: "Your account email is now {{newEmail}}. If this was not you, contact support right away.",
  },
  {
    key: "auth.sign-up",
    title: "Finish sign-up",
    variables: { product: { kind: "string" }, ...LINK },
    subject: "Finish creating your {{product}} account",
    body: "[Finish sign-up]({{link}})\n\n {{link}} \n\nThe link works until {{expires}}.",
  },
  {
    key: "auth.account-exists",
    title: "Account already exists",
    variables: { product: { kind: "string" } },
    subject: "You already have a {{product}} account",
    body: "Someone tried to sign up with this address, but it already has an account. You can sign in or reset your password.",
  },
  {
    key: "auth.verify-email",
    title: "Verify email",
    variables: { product: { kind: "string" }, ...LINK },
    subject: "Verify your {{product}} email",
    body: "[Verify this address]({{link}})\n\nThe link works until {{expires}}.",
  },
  {
    key: "auth.sign-in-link",
    title: "Sign-in link",
    variables: { product: { kind: "string" }, code: { kind: "string" }, ...LINK },
    subject: "Sign in to {{product}}",
    body: "[Sign in]({{link}})\n\nOr type this code on the sign-in page: **{{code}}**\n\nIt works once until {{expires}}.",
  },
  {
    key: "auth.impersonated",
    title: "Support viewed your account",
    variables: { product: { kind: "string" }, operator: { kind: "string" }, minutes: { kind: "number" } },
    subject: "{{product}} staff opened your account",
    body: "{{operator}} opened your account for up to {{minutes}} minutes to help you. Every action was recorded in your activity log.",
  },
] as const satisfies readonly EmailDef[];

export function pgSamlReplayStore(pool: PgPool, table: string): SamlReplayStore {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(table)) throw new KitAuthError("invalid", `not a valid table name: ${table}`);
  let ready: Promise<unknown> | null = null;
  return {
    async claim(key: string, untilMs: number): Promise<boolean> {
      ready ??= pool.query(`CREATE TABLE IF NOT EXISTS "${table}" (key text PRIMARY KEY, until bigint NOT NULL)`).catch((e) => {
        ready = null;
        throw e;
      });
      await ready;
      await pool.query(`DELETE FROM "${table}" WHERE until < $1`, [Date.now()]);
      const res = await pool.query(`INSERT INTO "${table}" (key, until) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key`, [key, untilMs]);
      return res.rows.length === 1;
    },
  };
}

export function defineKitAuth(o: KitAuthOptions) {
  if (!PREFIX.test(o.prefix)) throw new KitAuthError("invalid", `table prefix must look like "loom_": ${o.prefix}`);
  const pages = { ...DEFAULT_KIT_AUTH_PAGES, ...o.pages };
  const now = o.now ?? Date.now;
  const product = o.name;
  const maxMinutes = Math.min(Math.max(o.maxImpersonationMinutes ?? 30, 1), 240);
  const table = (name: string) => `${o.prefix}${name}`;

  const sessions = new PgSessionStore(o.pool, table("sessions"));

  const account = defineAccount({
    url: o.url,
    send: (m) => {
      switch (m.kind) {
        case "password-reset":
        case "email-change":
        case "sign-up":
        case "verify-email": {
          console.log(m.link)
          return o.mail(`auth.${m.kind}`, m.to, { product, link: m.link, expires: m.expires });
        }
        case "email-changed":
          return o.mail("auth.email-changed", m.to, { product, newEmail: m.newEmail });
        default:
          return o.mail(`auth.${m.kind}`, m.to, { product });
      }
    },
    findUser: async (email) => (await o.users.byEmail(email))?.id ?? null,
    emailOf: async (user) => (await o.users.byId(user))?.email ?? null,
    setPassword: async (user, hash) => {
      await o.users.setPassword(user, hash);
      await o.activity.log({ scope: o.auditScope(user), actor: user, action: "auth.password.changed", target: user });
    },
    setEmail: async (user, email) => {
      await o.users.setEmail(user, email);
      await o.activity.log({ scope: o.auditScope(user), actor: user, action: "auth.email.changed", target: user });
    },
    createUser: async (email, hash) => {
      const id = await o.users.create(email, hash);
      await o.activity.log({ scope: o.auditScope(id), actor: id, action: "auth.user.created", target: id });
      return id;
    },
    markVerified: (user, email) => o.users.markVerified(user, email),
    allowSignUp: o.allowSignUp ?? (() => false),
    signUpPage: pages.signUp,
    resetPage: pages.reset,
    verifyPage: pages.verify,
    emailPage: pages.email,
    minPasswordLength: o.minPasswordLength ?? 12,
    store: new PgAccountTokenStore(o.pool, table("account_tokens")),
    now,
  });

  const email = emailSignIn({
    url: o.url,
    page: pages.emailSignIn,
    allow: async (address) => (await o.users.byEmail(address)) !== null,
    send: ({ email: to, link, code, expires }) => o.mail("auth.sign-in-link", to, { product, link, code, expires: expires.getTime() }),
    store: new PgEmailTokenStore(o.pool, table("email_tokens")),
    now,
  });

  const twoFactor = defineTwoFactor({
    key: o.key,
    issuer: product,
    page: pages.twoFactor,
    require: o.requireTwoFactor,
    store: new PgTwoFactorStore(o.pool, table("two_factor")),
    now,
  });

  const passkeys = definePasskeys({ url: o.url, name: product, store: new PgPasskeyStore(o.pool, table("passkeys")), now });

  const saml = o.saml ? defineSaml({ connection: o.saml, replay: pgSamlReplayStore(o.pool, table("saml_replay")), now }) : null;

  async function signIn(identity: Identity): Promise<string | null> {
    const linked = o.users.byIdentity ? await o.users.byIdentity(identity) : null;
    if (linked) return linked;
    if (!identity.email || !identity.emailVerified) return null;
    return (await o.users.byEmail(identity.email))?.id ?? null;
  }

  async function impersonate(ctx: PageContext, operator: string, input: { user: string; tenant?: string; minutes?: number; reason: string; ip?: string | null }): Promise<boolean> {
    const reason = input.reason.trim();
    if (reason.length < 4) throw new KitAuthError("invalid", "a reason is required to view as another user");
    if (operator === input.user) throw new KitAuthError("invalid", "cannot view as yourself");
    if (viewingAs(ctx)) throw new KitAuthError("forbidden", "already viewing as someone");
    if (!(await o.canImpersonate(operator, input.user, input.tenant))) throw new KitAuthError("forbidden", "not allowed to view as this user");
    const target = await o.users.byId(input.user);
    if (!target) throw new KitAuthError("invalid", "unknown user");
    const minutes = Math.min(Math.max(Math.round(input.minutes ?? 15), 1), maxMinutes);
    const ok = await viewAs(ctx, input.user, { tenant: input.tenant, until: now() + minutes * 60_000 });
    if (!ok) return false;
    await o.activity.log({
      scope: o.auditScope(input.user),
      actor: input.user,
      impersonator: operator,
      action: "auth.impersonate.start",
      target: input.user,
      summary: reason,
      meta: { minutes, tenant: input.tenant ?? null },
      ip: input.ip ?? null,
    });
    const op = await o.users.byId(operator);
    await o.mail("auth.impersonated", target.email, { product, operator: op?.email ?? operator, minutes });
    return true;
  }

  async function stopImpersonating(ctx: PageContext, ip?: string | null): Promise<boolean> {
    const v = viewingAs(ctx);
    if (!v) return false;
    const ok = await stopViewingAs(ctx);
    if (ok) {
      await o.activity.log({ scope: o.auditScope(v.user), actor: v.user, impersonator: v.operator, action: "auth.impersonate.stop", target: v.user, ip: ip ?? null });
    }
    return ok;
  }

  return { pages, sessions, account, email, twoFactor, passkeys, saml, providers: o.providers ?? [], signIn, impersonate, stopImpersonating };
}

export type KitAuth = ReturnType<typeof defineKitAuth>;
