import { createHmac } from "node:crypto";

export const hmacHex = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest("hex");
export const hmacBase64 = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest("base64");
/** Blofin and OKX sign the hex digest, then base64 that string. */
export const hmacHexThenBase64 = (secret: string, payload: string) => Buffer.from(hmacHex(secret, payload)).toString("base64");

export function query(params: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  return pairs.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
}
