import { API_BASE, deviceToken, isNative } from "./platform";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setCsrf(t: string | null | undefined) {
  csrfToken = t ?? null;
}
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; raw?: boolean } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (isNative) {
    const t = await deviceToken.get();
    if (t) headers["Authorization"] = `Bearer ${t}`;
  } else if (method !== "GET" && csrfToken) {
    headers["X-CSRF-Token"] = csrfToken;
  }
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: isNative ? "omit" : "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "network", "تعذر الاتصال بالخادم. تحقق من الإنترنت.");
  }
  if (res.status === 401 && !path.startsWith("/api/auth/login")) onUnauthorized?.();
  if (opts.raw) {
    if (!res.ok) throw new ApiError(res.status, "http", `HTTP ${res.status}`);
    return res as unknown as T;
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? "http", e.message ?? `HTTP ${res.status}`, e.details);
  }
  return data as T;
}

/** Downloads a file from the API (CSV / backup) respecting the auth mode. */
export async function download(path: string, filename: string) {
  const res = await api<Response>(path, { raw: true });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
