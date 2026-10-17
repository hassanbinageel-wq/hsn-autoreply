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

/** A customer's plan does not include what they tried: the app shows an "upgrade" box (see UpgradeModal). */
const PLAN_CODES = new Set(["plan_feature", "plan_event", "plan_campaigns", "plan_draws", "subscription_inactive", "monthly_limit_reached"]);
export function notifyPlanBlocked(message: string) {
  window.dispatchEvent(new CustomEvent("hsn:plan-blocked", { detail: { message } }));
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
    const err = new ApiError(res.status, e.code ?? "http", e.message ?? `HTTP ${res.status}`, e.details);
    if (res.status === 403 && PLAN_CODES.has(err.code)) notifyPlanBlocked(err.message);
    throw err;
  }
  return data as T;
}

/** Downloads a file from the API (CSV / backup) respecting the auth mode. */
export async function download(path: string, filename: string) {
  const res = await api<Response>(path, { raw: true });
  const { saveFile } = await import("./lib/save");
  await saveFile(await res.blob(), filename);
}

/** Uploads a file as the raw request body (PUT), with progress (0..1). Same auth rules as `api`. */
export async function uploadFile<T = any>(path: string, file: Blob, onProgress?: (p: number) => void): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": file.type };
  if (isNative) {
    const t = await deviceToken.get();
    if (t) headers["Authorization"] = `Bearer ${t}`;
  } else if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  return new Promise<T>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", API_BASE + path);
    x.withCredentials = !isNative;
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onerror = () => reject(new ApiError(0, "network", "انقطع الاتصال أثناء الرفع. حاول مرة ثانية."));
    x.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(x.responseText);
      } catch {
        /* empty */
      }
      if (x.status >= 200 && x.status < 300) return resolve(data as T);
      const e = data?.error ?? {};
      if (x.status === 401) onUnauthorized?.();
      reject(new ApiError(x.status, e.code ?? "http", e.message ?? (x.status === 413 ? "الملف كبير جدًا" : `HTTP ${x.status}`)));
    };
    x.send(file);
  });
}

/** An object URL for a private file served by the API (works in the app too, where <img> cannot send the token). */
export async function authedObjectUrl(path: string): Promise<string> {
  const res = await api<Response>(path, { raw: true });
  return URL.createObjectURL(await res.blob());
}
