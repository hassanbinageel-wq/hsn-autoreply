import type { Env } from "../env";
import { first, run } from "../lib/db";
import { hashPassword, randomToken, sha256Hex, verifyPassword } from "../lib/crypto";
import { emailEnabled, emailLayout, sendEmail } from "./email";

/**
 * Account email and password recovery: a confirmed email receives a one-time reset link (30 minutes).
 * Answers never reveal whether an account or an email exists.
 */

const MIN = 60_000;
export const RESET_TTL = 30 * MIN;
const CODE_TTL = 15 * MIN;

export const normEmail = (e: string) => e.trim().toLowerCase();

/** Sends a 6-digit confirmation code to a (new) email of the user. The email is set once the code is confirmed. */
export async function sendEmailCode(env: Env, userId: number, email: string, now = Date.now()): Promise<{ ok: boolean; error?: string }> {
  if (!emailEnabled(env)) return { ok: false, error: "email_not_configured" };
  const e = normEmail(email);
  const taken = await first(env.DB, "SELECT 1 FROM admin_users WHERE email = ? COLLATE NOCASE AND email_verified_at IS NOT NULL AND id != ?", e, userId);
  if (taken) return { ok: false, error: "email_taken" };
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  const code = String(n).padStart(6, "0");
  await run(
    env.DB,
    "INSERT INTO email_codes (user_id, email, code_hash, attempts, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at, created_at = excluded.created_at",
    userId,
    e,
    await sha256Hex(`${userId}:${code}`),
    now + CODE_TTL,
    now,
  );
  // Remember the address as pending (shown in settings until it is confirmed).
  await run(env.DB, "UPDATE admin_users SET email = ?, email_verified_at = NULL, updated_at = ? WHERE id = ? AND (email IS NULL OR email_verified_at IS NULL OR email != ?)", e, now, userId, e);
  const r = await sendEmail(env, {
    to: e,
    subject: `رمز تأكيد إيميلك: ${code}`,
    text: `رمز تأكيد إيميلك في شيّك: ${code}\nصالح 15 دقيقة.\nإذا ما طلبت هذا، تجاهل الرسالة.`,
    html: emailLayout({ title: "تأكيد إيميلك", lines: ["اكتب هذا الرمز في التطبيق لتأكيد إيميلك. نستخدمه فقط لاسترجاع حسابك إذا نسيت كلمة المرور.", "الرمز صالح 15 دقيقة."], code }),
  });
  return r;
}

export async function confirmEmailCode(db: D1Database, userId: number, code: string, now = Date.now()): Promise<"ok" | "invalid" | "expired" | "taken"> {
  const row = await first<{ email: string; code_hash: string; attempts: number; expires_at: number }>(db, "SELECT email, code_hash, attempts, expires_at FROM email_codes WHERE user_id = ?", userId);
  if (!row) return "invalid";
  if (row.expires_at < now || row.attempts >= 5) return "expired";
  if ((await sha256Hex(`${userId}:${code.replace(/\D/g, "")}`)) !== row.code_hash) {
    await run(db, "UPDATE email_codes SET attempts = attempts + 1 WHERE user_id = ?", userId);
    return "invalid";
  }
  if (await first(db, "SELECT 1 FROM admin_users WHERE email = ? COLLATE NOCASE AND email_verified_at IS NOT NULL AND id != ?", row.email, userId)) return "taken";
  await db.batch([
    db.prepare("UPDATE admin_users SET email = ?, email_verified_at = ?, updated_at = ? WHERE id = ?").bind(row.email, now, now, userId),
    db.prepare("DELETE FROM email_codes WHERE user_id = ?").bind(userId),
  ]);
  return "ok";
}

/**
 * «Forgot password»: by store name (login) or email. Sends a link only to a confirmed email; otherwise silently
 * does nothing (the caller always answers the same way).
 */
export async function requestPasswordReset(env: Env, login: string, baseUrl: string, now = Date.now()): Promise<"sent" | "none"> {
  if (!emailEnabled(env)) return "none";
  const v = login.trim();
  const u = v.includes("@")
    ? await first<{ id: number; username: string; email: string }>(env.DB, "SELECT id, username, email FROM admin_users WHERE email = ? COLLATE NOCASE AND email_verified_at IS NOT NULL LIMIT 1", normEmail(v))
    : await first<{ id: number; username: string; email: string | null; email_verified_at: number | null }>(env.DB, "SELECT id, username, email, email_verified_at FROM admin_users WHERE username = ? COLLATE NOCASE ORDER BY (username = ?) DESC LIMIT 1", v, v).then((x) => (x?.email && x.email_verified_at ? x : null));
  if (!u?.email) return "none";
  // At most 3 links per account per hour.
  const recent = await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at >= ?", u.id, now - 60 * MIN);
  if ((recent?.n ?? 0) >= 3) return "none";
  const token = randomToken(32);
  await run(env.DB, "INSERT INTO password_resets (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", await sha256Hex(token), u.id, now + RESET_TTL, now);
  const link = `${baseUrl.replace(/\/$/, "")}/#/reset?token=${encodeURIComponent(token)}`;
  const r = await sendEmail(env, {
    to: u.email,
    subject: "استرجاع كلمة المرور — شيّك",
    text: `طلبت تغيير كلمة المرور لحساب «${u.username}».\nافتح الرابط خلال 30 دقيقة (يشتغل مرة وحدة):\n${link}\nإذا ما طلبت هذا، تجاهل الرسالة — كلمة مرورك ما تتغير.`,
    html: emailLayout({
      title: "استرجاع كلمة المرور",
      lines: [`طلبت تغيير كلمة المرور لحساب «${u.username}».`, "اضغط الزر واكتب كلمة مرور جديدة. الرابط يشتغل 30 دقيقة ومرة وحدة بس."],
      button: { label: "تعيين كلمة مرور جديدة", url: link },
      footer: "إذا ما طلبت هذا، تجاهل الرسالة — كلمة مرورك ما تتغير. لا تشارك هذا الرابط مع أحد.",
    }),
  });
  if (!r.ok) console.error("reset email failed", r.error);
  return r.ok ? "sent" : "none";
}

/** Sets the new password from a valid link: the link and every other open link stop working; all sessions end. */
export async function resetPassword(env: Env, token: string, password: string, now = Date.now()): Promise<{ ok: true; username: string; tenant_id: number } | { ok: false }> {
  const h = await sha256Hex(token);
  const row = await first<{ user_id: number; expires_at: number; used_at: number | null }>(env.DB, "SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?", h);
  if (!row || row.used_at || row.expires_at < now) return { ok: false };
  const claimed = await run(env.DB, "UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL", now, h);
  if (!claimed.meta.changes) return { ok: false };
  const hash = await hashPassword(password, env.PASSWORD_PEPPER, Number(env.PBKDF2_ITERATIONS || 100_000));
  await env.DB.batch([
    env.DB.prepare("UPDATE admin_users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?").bind(hash, now, row.user_id),
    env.DB.prepare("UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL").bind(now, row.user_id),
    env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(now, row.user_id),
  ]);
  const u = await first<{ username: string; tenant_id: number; email: string | null }>(env.DB, "SELECT username, tenant_id, email FROM admin_users WHERE id = ?", row.user_id);
  if (u?.email)
    await sendEmail(env, {
      to: u.email,
      subject: "تم تغيير كلمة المرور — شيّك",
      text: `تم تغيير كلمة المرور لحساب «${u.username}» وتسجيل الخروج من كل الأجهزة.\nإذا ما سويت هذا بنفسك، تواصل مع الدعم فورًا.`,
      html: emailLayout({ title: "تم تغيير كلمة المرور ✅", lines: [`تم تغيير كلمة المرور لحساب «${u.username}» وتسجيل الخروج من كل الأجهزة.`], footer: "إذا ما سويت هذا بنفسك، تواصل مع الدعم فورًا." }),
    }).catch(() => undefined);
  return { ok: true, username: u?.username ?? "", tenant_id: u?.tenant_id ?? 0 };
}

/**
 * Changing the password from Settings: the current password, then a code sent to the confirmed email; the new
 * password applies only after the code (so a stolen session alone cannot change it).
 */
export async function startPasswordChange(env: Env, userId: number, current: string, next: string, now = Date.now()): Promise<"sent" | "wrong_current" | "same" | "no_email" | "email_off" | "send_failed"> {
  if (!emailEnabled(env)) return "email_off";
  const u = await first<{ password_hash: string; email: string | null; email_verified_at: number | null; username: string }>(env.DB, "SELECT password_hash, email, email_verified_at, username FROM admin_users WHERE id = ?", userId);
  if (!u) return "wrong_current";
  if (!(await verifyPassword(current, u.password_hash, env.PASSWORD_PEPPER))) return "wrong_current";
  if (current === next) return "same";
  if (!u.email || !u.email_verified_at) return "no_email";
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  const newHash = await hashPassword(next, env.PASSWORD_PEPPER, Number(env.PBKDF2_ITERATIONS || 100_000));
  await run(
    env.DB,
    "INSERT INTO password_changes (user_id, new_hash, code_hash, attempts, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(user_id) DO UPDATE SET new_hash = excluded.new_hash, code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at, created_at = excluded.created_at",
    userId,
    newHash,
    await sha256Hex(`pw:${userId}:${code}`),
    now + CODE_TTL,
    now,
  );
  const r = await sendEmail(env, {
    to: u.email,
    subject: `رمز تأكيد تغيير كلمة المرور: ${code}`,
    text: `طلب تغيير كلمة المرور لحساب «${u.username}».\nالرمز: ${code} (صالح 15 دقيقة).\nإذا ما طلبت هذا، لا تعطي الرمز لأحد وغيّر كلمة مرورك فورًا.`,
    html: emailLayout({ title: "تأكيد تغيير كلمة المرور", lines: [`طلب تغيير كلمة المرور لحساب «${u.username}». اكتب الرمز في التطبيق لإكمال التغيير.`, "الرمز صالح 15 دقيقة."], code, footer: "إذا ما طلبت هذا، لا تعطي الرمز لأحد وغيّر كلمة مرورك فورًا — كلمة المرور ما تتغير بدون الرمز." }),
  });
  return r.ok ? "sent" : "send_failed";
}

export async function confirmPasswordChange(env: Env, userId: number, keepSessionId: string, code: string, now = Date.now()): Promise<"ok" | "invalid" | "expired"> {
  const row = await first<{ new_hash: string; code_hash: string; attempts: number; expires_at: number }>(env.DB, "SELECT new_hash, code_hash, attempts, expires_at FROM password_changes WHERE user_id = ?", userId);
  if (!row) return "invalid";
  if (row.expires_at < now || row.attempts >= 5) return "expired";
  if ((await sha256Hex(`pw:${userId}:${code.replace(/\D/g, "")}`)) !== row.code_hash) {
    await run(env.DB, "UPDATE password_changes SET attempts = attempts + 1 WHERE user_id = ?", userId);
    return "invalid";
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE admin_users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?").bind(row.new_hash, now, userId),
    env.DB.prepare("DELETE FROM password_changes WHERE user_id = ?").bind(userId),
    // Other devices sign out; this one stays signed in.
    env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL").bind(now, userId, keepSessionId),
  ]);
  const u = await first<{ username: string; email: string | null }>(env.DB, "SELECT username, email FROM admin_users WHERE id = ?", userId);
  if (u?.email)
    await sendEmail(env, {
      to: u.email,
      subject: "تم تغيير كلمة المرور — شيّك",
      text: `تم تغيير كلمة المرور لحساب «${u.username}» وتسجيل الخروج من الأجهزة الأخرى.\nإذا ما سويت هذا بنفسك، تواصل مع الدعم فورًا.`,
      html: emailLayout({ title: "تم تغيير كلمة المرور ✅", lines: [`تم تغيير كلمة المرور لحساب «${u.username}» وتسجيل الخروج من الأجهزة الأخرى.`], footer: "إذا ما سويت هذا بنفسك، تواصل مع الدعم فورًا." }),
    }).catch(() => undefined);
  return "ok";
}
