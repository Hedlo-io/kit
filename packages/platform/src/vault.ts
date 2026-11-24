import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export class VaultError extends Error {}

export interface SecretLike {
  reveal(): string;
}

function keyOf(secret: SecretLike | string, info: string): Buffer {
  const raw = typeof secret === "string" ? secret : secret.reveal();
  if (raw.length < 32) throw new VaultError("the vault key must be at least 32 characters");
  return Buffer.from(hkdfSync("sha256", raw, info, "v1", 32));
}

export function sealSecret(secret: SecretLike | string, info: string, id: string, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyOf(secret, info), iv);
  cipher.setAAD(Buffer.from(id, "utf8"));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

export function openSecret<T>(secret: SecretLike | string, info: string, id: string, sealed: string): T {
  if (!sealed.startsWith("v1.")) throw new VaultError(`vault entry ${id} has an unknown format`);
  const raw = Buffer.from(sealed.slice(3), "base64url");
  if (raw.length < 28) throw new VaultError(`vault entry ${id} is truncated`);
  const decipher = createDecipheriv("aes-256-gcm", keyOf(secret, info), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(id, "utf8"));
  decipher.setAuthTag(raw.subarray(12, 28));
  try {
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as T;
  } catch {
    throw new VaultError(`vault entry ${id} cannot be opened with this key`);
  }
}
