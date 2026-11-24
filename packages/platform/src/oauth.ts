import { github, google, microsoft, oidc, type Provider } from "@weft-framework/server";

export interface OAuthButton {
  id: string;
  label: string;
  href: string;
}

type Env = Readonly<Record<string, string | undefined>>;

function pair(env: Env, prefix: string, name: string): { clientId: string; clientSecret: string } | null {
  const clientId = (env[`${prefix}_${name}_CLIENT_ID`] ?? "").trim();
  const clientSecret = (env[`${prefix}_${name}_CLIENT_SECRET`] ?? "").trim();
  if (!clientId && !clientSecret) return null;
  if (!clientId || clientSecret.length < 8) throw new Error(`${prefix}_${name}_CLIENT_ID and ${prefix}_${name}_CLIENT_SECRET must both be set`);
  return { clientId, clientSecret };
}

export function oauthProviders(prefix: string, env: Env = process.env): Provider[] {
  const out: Provider[] = [];
  const g = pair(env, prefix, "GOOGLE");
  if (g) out.push(google(g));
  const gh = pair(env, prefix, "GITHUB");
  if (gh) out.push(github(gh));
  const ms = pair(env, prefix, "MICROSOFT");
  const tenant = (env[`${prefix}_MICROSOFT_TENANT`] ?? "").trim();
  if (ms) out.push(microsoft({ ...ms, ...(tenant ? { tenant } : {}) }));
  const o = pair(env, prefix, "OIDC");
  if (o) {
    const issuer = (env[`${prefix}_OIDC_ISSUER`] ?? "").trim();
    if (!issuer.startsWith("https://")) throw new Error(`${prefix}_OIDC_ISSUER must be an https URL`);
    out.push(oidc({ ...o, id: "sso", issuer, label: (env[`${prefix}_OIDC_LABEL`] ?? "").trim() || "SSO" }));
  }
  return out;
}

export function oauthButtons(providers: readonly Provider[], next: string): OAuthButton[] {
  const q = next && next !== "/" ? `?next=${encodeURIComponent(next)}` : "";
  return providers.map((p) => ({ id: p.id, label: p.label, href: `/_weft/auth/${encodeURIComponent(p.id)}${q}` }));
}
