import type { ChannelConfig, Delivery, DigestDelivery } from "@weft-framework/core";

export type ChatKind = "discord" | "slack";

export class ChatHookError extends Error {}

const HOSTS: Record<ChatKind, RegExp> = {
  discord: /^(?:canary\.|ptb\.)?discord(?:app)?\.com$/,
  slack: /^hooks\.slack\.com$/,
};
const PATHS: Record<ChatKind, RegExp> = {
  discord: /^\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200}$/,
  slack: /^\/services\/[A-Z0-9]{5,20}\/[A-Z0-9]{5,20}\/[A-Za-z0-9]{10,64}$/,
};

export function chatHookUrl(kind: ChatKind, raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 500) throw new ChatHookError(`${kind}: a webhook URL`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ChatHookError(`${kind}: a webhook URL`);
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !HOSTS[kind].test(u.hostname) || !PATHS[kind].test(u.pathname)) {
    throw new ChatHookError(`${kind}: not a ${kind === "discord" ? "Discord" : "Slack"} webhook URL`);
  }
  return `https://${u.hostname}${u.pathname}`;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function neutral(s: string): string {
  return s.replace(/@(everyone|here)/g, "@​$1").replace(/<([@#!&])/g, "<​$1");
}

export interface ChatMessage {
  title: string;
  body?: string;
  url?: string | null;
  level?: "info" | "success" | "warning" | "critical";
  fields?: { name: string; value: string }[];
}

const COLORS = { info: 0x3b82f6, success: 0x22c55e, warning: 0xf59e0b, critical: 0xef4444 };

export function chatPayload(kind: ChatKind, m: ChatMessage, product = "Loom"): unknown {
  const title = neutral(clip(m.title, 240));
  const body = neutral(clip(m.body ?? "", 3500));
  const url = m.url && /^https:\/\//.test(m.url) ? m.url : undefined;
  const fields = (m.fields ?? []).slice(0, 10).map((f) => ({ name: neutral(clip(f.name, 200)), value: neutral(clip(f.value, 900)) }));
  if (kind === "discord") {
    return {
      username: clip(product, 80),
      allowed_mentions: { parse: [] },
      embeds: [{ title, description: body || undefined, url, color: COLORS[m.level ?? "info"], fields: fields.map((f) => ({ ...f, inline: true })) }],
    };
  }
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    text: `${esc(title)}${body ? `\n${esc(body)}` : ""}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${url ? `<${url}|${esc(title)}>` : esc(title)}*${body ? `\n${esc(body)}` : ""}` } },
      ...(fields.length ? [{ type: "section", fields: fields.map((f) => ({ type: "mrkdwn", text: `*${esc(f.name)}*\n${esc(f.value)}` })) }] : []),
    ],
  };
}

export interface ChatSender {
  (url: string, body: string): Promise<{ status: number }>;
}

export const fetchSender: ChatSender = async (url, body) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(10_000) });
  return { status: res.status };
};

export async function sendChat(kind: ChatKind, url: string, m: ChatMessage, opts: { product?: string; send?: ChatSender } = {}): Promise<void> {
  const target = chatHookUrl(kind, url);
  const { status } = await (opts.send ?? fetchSender)(target, JSON.stringify(chatPayload(kind, m, opts.product)));
  if (status < 200 || status >= 300) throw new ChatHookError(`${kind} webhook answered ${status}`);
}

export function chatChannel(kind: ChatKind, opts: { label?: string; urlFor(user: string): string | null | Promise<string | null>; product?: string; send?: ChatSender }): ChannelConfig {
  return {
    label: opts.label ?? (kind === "discord" ? "Discord" : "Slack"),
    async send(d: Delivery) {
      const url = await opts.urlFor(d.user);
      if (!url) return;
      const n = d.notification as unknown as { title: string; body?: string; url?: string | null };
      await sendChat(kind, url, { title: n.title, body: n.body, url: n.url ?? null }, opts);
    },
    async digest(d: DigestDelivery) {
      const url = await opts.urlFor(d.user);
      if (!url || d.notifications.length === 0) return;
      const list = d.notifications as unknown as { title: string }[];
      await sendChat(kind, url, { title: `${list.length} updates`, body: list.slice(0, 20).map((n) => `• ${n.title}`).join("\n") }, opts);
    },
  };
}
