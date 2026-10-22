import type { Env } from "../env";
import { getSetting, setSetting } from "../lib/db";
import { sanitize } from "../meta/client";

/**
 * Transactional email through Resend (resend.com — free up to 3,000 emails a month / 100 a day).
 * Used only for account recovery and email confirmation. Off until the RESEND_API_KEY secret is set.
 */

export const emailEnabled = (env: Env) => !!env.RESEND_API_KEY;

const DEFAULT_FROM = "شيّك Shayyek <no-reply@shayyek.sa>";

async function post(env: Env, from: string, m: { to: string; subject: string; text: string; html: string }): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return { ok: false, status: r.status, error: sanitize(`resend ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: sanitize(String((e as Error)?.message ?? e)) };
  }
}

/**
 * Sends from EMAIL_FROM; when Resend refuses that sender (e.g. a domain not verified for this API key) and
 * EMAIL_FROM_FALLBACK is set, retries once from the fallback. The last failure is kept for the owner's diagnostics.
 */
export async function sendEmail(env: Env, m: { to: string; subject: string; text: string; html: string }): Promise<{ ok: boolean; error?: string }> {
  if (!env.RESEND_API_KEY) return { ok: false, error: "email_not_configured" };
  const from = env.EMAIL_FROM || DEFAULT_FROM;
  let r = await post(env, from, m);
  if (!r.ok && r.status && r.status >= 400 && r.status < 500 && r.status !== 429 && env.EMAIL_FROM_FALLBACK && env.EMAIL_FROM_FALLBACK !== from) {
    await noteEmailError(env, `${from} → ${r.error}`);
    r = await post(env, env.EMAIL_FROM_FALLBACK, m);
  }
  if (!r.ok) await noteEmailError(env, r.error ?? "unknown");
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

async function noteEmailError(env: Env, error: string): Promise<void> {
  console.error("email failed", error);
  await setSetting(env.DB, 1, "email_last_error", { at: Date.now(), error }).catch(() => undefined);
}

/** The last Resend failure (owner diagnostics). */
export function lastEmailError(env: Env): Promise<{ at: number; error: string } | null> {
  return getSetting<{ at: number; error: string } | null>(env.DB, 1, "email_last_error", null);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A simple right-to-left email: title, paragraphs, an optional button and a small footer. */
export function emailLayout(o: { title: string; lines: string[]; button?: { label: string; url: string }; code?: string; footer?: string }): string {
  const p = o.lines.map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.7;color:#334155">${esc(l)}</p>`).join("");
  const btn = o.button ? `<p style="margin:20px 0"><a href="${esc(o.button.url)}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:12px;font-size:15px">${esc(o.button.label)}</a></p>` : "";
  const code = o.code ? `<p style="margin:18px 0;font-size:30px;letter-spacing:8px;font-weight:bold;color:#0f172a;direction:ltr;text-align:center">${esc(o.code)}</p>` : "";
  return `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#f5f3ff;font-family:Tahoma,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border-radius:18px;padding:24px;border:1px solid #ede9fe">
<p style="margin:0 0 6px;font-size:13px;font-weight:bold;color:#7c3aed">شيّك</p>
<h1 style="margin:0 0 16px;font-size:20px;color:#0f172a">${esc(o.title)}</h1>${p}${code}${btn}
<p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:#94a3b8">${esc(o.footer ?? "إذا ما طلبت هذا، تجاهل الرسالة — حسابك بأمان ولن يتغير شيء.")}</p>
</div></div></body></html>`;
}
