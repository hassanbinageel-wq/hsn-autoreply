import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../env";
import { first, run } from "../lib/db";
import { randomToken, sha256Hex, timingSafeEqual } from "../lib/crypto";

export const SESSION_COOKIE = "__Host-hsn_session";
export const WEB_SESSION_TTL = 12 * 60 * 60 * 1000; // 12h
export const DEVICE_SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days (sliding)

export interface SessionInfo {
  id: string;
  user_id: number;
  kind: "web" | "device";
  csrf_token: string | null;
  username: string;
}

export type AppEnv = { Bindings: Env; Variables: { session: SessionInfo } };

export async function createSession(
  db: D1Database,
  userId: number,
  kind: "web" | "device",
  label?: string | null,
): Promise<{ token: string; csrf: string | null; expiresAt: number }> {
  const token = randomToken(32);
  const csrf = kind === "web" ? randomToken(24) : null;
  const now = Date.now();
  const expiresAt = now + (kind === "web" ? WEB_SESSION_TTL : DEVICE_SESSION_TTL);
  await run(
    db,
    "INSERT INTO sessions (id, user_id, kind, csrf_token, device_label, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    await sha256Hex(token),
    userId,
    kind,
    csrf,
    label ?? null,
    now,
    expiresAt,
    now,
  );
  return { token, csrf, expiresAt };
}

async function lookup(db: D1Database, token: string, kind: "web" | "device"): Promise<SessionInfo | null> {
  if (!token || token.length > 128) return null;
  const now = Date.now();
  const s = await first<SessionInfo & { expires_at: number; last_seen_at: number }>(
    db,
    `SELECT s.id, s.user_id, s.kind, s.csrf_token, s.expires_at, s.last_seen_at, u.username
       FROM sessions s JOIN admin_users u ON u.id = s.user_id
      WHERE s.id = ? AND s.kind = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    await sha256Hex(token),
    kind,
    now,
  );
  if (!s) return null;
  if (now - s.last_seen_at > 5 * 60_000) {
    // sliding expiry for device sessions; web sessions keep a hard 12h limit
    const newExp = kind === "device" ? now + DEVICE_SESSION_TTL : s.expires_at;
    await run(db, "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?", now, newExp, s.id);
  }
  return { id: s.id, user_id: s.user_id, kind: s.kind, csrf_token: s.csrf_token, username: s.username };
}

export function allowedAppOrigins(env: Env): string[] {
  return (env.ALLOWED_APP_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function sameOrigin(c: Context<AppEnv>): boolean {
  const origin = c.req.header("Origin");
  if (!origin) return true; // same-origin GET/POST from some browsers omit Origin; CSRF token still required
  const self = new URL(c.req.url).origin;
  const pub = c.env.PUBLIC_BASE_URL ? new URL(c.env.PUBLIC_BASE_URL).origin : self;
  return origin === self || origin === pub;
}

/**
 * Authentication:
 *  - Web (PWA): HttpOnly Secure SameSite=Strict cookie + CSRF header on state-changing requests + Origin check.
 *  - Android app: "Authorization: Bearer <device token>" (not sent automatically by browsers, so no CSRF risk).
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.req.header("Authorization");
  let session: SessionInfo | null = null;
  if (auth?.startsWith("Bearer ")) {
    session = await lookup(c.env.DB, auth.slice(7).trim(), "device");
  } else {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) {
      session = await lookup(c.env.DB, cookie, "web");
      if (session && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
        const header = c.req.header("X-CSRF-Token") ?? "";
        if (!sameOrigin(c) || !session.csrf_token || !timingSafeEqual(header, session.csrf_token)) {
          return c.json({ error: { code: "csrf", message: "طلب غير موثوق (CSRF)" } }, 403);
        }
      }
    }
  }
  if (!session) return c.json({ error: { code: "unauthorized", message: "يلزم تسجيل الدخول" } }, 401);
  c.set("session", session);
  await next();
};

/** Fixed-window rate limiter stored in D1. Returns true if the request is allowed. */
export async function rateLimit(db: D1Database, key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const row = await first<{ count: number; window_start: number }>(
    db,
    `INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < ? THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < ? THEN excluded.window_start ELSE rate_limits.window_start END
     RETURNING count, window_start`,
    key,
    now,
    now - windowMs,
    now - windowMs,
  );
  return (row?.count ?? 0) <= limit;
}

export function clientIp(c: Context<AppEnv>): string {
  return c.req.header("CF-Connecting-IP") ?? "unknown";
}
