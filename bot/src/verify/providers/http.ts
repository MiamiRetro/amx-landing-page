import { ProviderError } from "../types.js";

export interface HttpOptions {
  method?: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** One request with a timeout, returning parsed JSON or a ProviderError. */
export async function requestJson<T>(url: string, opts: HttpOptions): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 12_000);
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? "GET", headers: opts.headers, body: opts.body, signal: ac.signal });
  } catch (e) {
    throw new ProviderError(e instanceof Error && e.name === "AbortError" ? "exchange timed out" : `network error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) throw new ProviderError(`HTTP ${res.status}`, res.status, text.slice(0, 500));
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError("exchange returned a non-JSON body", res.status, text.slice(0, 500));
  }
}
