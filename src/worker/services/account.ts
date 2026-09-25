import type { Env } from "../env";
import { audit, first, run } from "../lib/db";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { HttpMetaClient, INSTAGRAM_SCOPES, WEBHOOK_FIELDS } from "../meta/client";
import { DemoMetaClient } from "../meta/demo";
import type { AccountRow, EngineContext } from "../engine/context";
import { cancelJobsWhere } from "../engine/jobs";

export const DEFAULT_API_VERSION = "v26.0";

export function metaClient(env: Env, onRequest?: () => void): HttpMetaClient {
  return new HttpMetaClient({
    apiVersion: env.META_API_VERSION || DEFAULT_API_VERSION,
    appId: env.INSTAGRAM_APP_ID,
    appSecret: env.INSTAGRAM_APP_SECRET,
    onRequest,
  });
}

export function redirectUri(env: Env): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/oauth/instagram/callback`;
}

const aad = (igUserId: string) => `ig-token:${igUserId}`;

export async function getAccessToken(env: Env, db: D1Database, account: AccountRow): Promise<string | null> {
  if (account.is_demo) return "demo-token";
  const row = await first<{ token_ciphertext: string | null; token_iv: string | null }>(
    db,
    "SELECT token_ciphertext, token_iv FROM instagram_accounts WHERE id = ?",
    account.id,
  );
  if (!row?.token_ciphertext || !row.token_iv) return null;
  try {
    return await decryptSecret(row.token_ciphertext, row.token_iv, env.TOKEN_ENC_KEY, aad(account.ig_user_id));
  } catch {
    return null;
  }
}

export async function markNeedsReauth(db: D1Database, account: AccountRow, message: string): Promise<void> {
  if (account.is_demo) return;
  const now = Date.now();
  await run(
    db,
    "UPDATE instagram_accounts SET status = 'needs_reauth', last_error = ?, updated_at = ? WHERE id = ? AND status = 'active'",
    message.slice(0, 300),
    now,
    account.id,
  );
  await cancelJobsWhere(db, "account_id = ? AND kind != 'process_event'", now, account.id);
  await audit(db, "system", "account.needs_reauth", String(account.id), { message: message.slice(0, 200) });
}

/** Builds the engine context used by the queue runner. */
export function engineContext(env: Env, onRequest?: () => void): EngineContext {
  const real = metaClient(env, onRequest);
  const demo = new DemoMetaClient(env.DB);
  return {
    db: env.DB,
    now: () => Date.now(),
    meta: (isDemo) => (isDemo ? demo : real),
    getAccessToken: (a) => getAccessToken(env, env.DB, a),
    onAuthError: (a, m) => markNeedsReauth(env.DB, a, m),
  };
}

export interface ConnectResult {
  ok: boolean;
  error?: string;
  accountId?: number;
}

/** Completes Instagram Login: code → short-lived token → long-lived token → profile → encrypted storage → webhook subscription. */
export async function completeOAuth(env: Env, code: string): Promise<ConnectResult> {
  const meta = metaClient(env);
  const short = await meta.exchangeCode(code, redirectUri(env));
  if (!short.ok) return { ok: false, error: `code_exchange: ${short.error.message}` };
  const long = await meta.exchangeLongLived(short.data.access_token);
  if (!long.ok) return { ok: false, error: `long_lived_exchange: ${long.error.message}` };
  const token = long.data.access_token;
  const me = await meta.getMe(token);
  if (!me.ok) return { ok: false, error: `profile: ${me.error.message}` };
  const igUserId = String(me.data.user_id ?? short.data.user_id ?? "");
  if (!igUserId) return { ok: false, error: "profile: missing user_id" };

  const now = Date.now();
  const enc = await encryptSecret(token, env.TOKEN_ENC_KEY, aad(igUserId));
  const scopes = short.data.permissions?.length ? short.data.permissions : [...INSTAGRAM_SCOPES];
  const expiresAt = long.data.expires_in ? now + long.data.expires_in * 1000 : null;

  // Single-account system: a newly connected account replaces any previously connected (non-demo) one.
  await run(
    env.DB,
    "UPDATE instagram_accounts SET status = 'disconnected', token_ciphertext = NULL, token_iv = NULL, disconnected_at = ?, updated_at = ? WHERE is_demo = 0 AND ig_user_id != ? AND status != 'disconnected'",
    now,
    now,
    igUserId,
  );
  await run(
    env.DB,
    `INSERT INTO instagram_accounts
       (ig_user_id, app_scoped_id, username, name, profile_picture_url, account_type, is_demo, token_ciphertext, token_iv, token_key_version,
        token_expires_at, token_refreshed_at, scopes, status, api_version, connected_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, ?, 'active', ?, ?, ?, ?)
     ON CONFLICT(ig_user_id) DO UPDATE SET
       app_scoped_id = excluded.app_scoped_id, username = excluded.username, name = excluded.name,
       profile_picture_url = excluded.profile_picture_url, account_type = excluded.account_type,
       token_ciphertext = excluded.token_ciphertext, token_iv = excluded.token_iv, token_key_version = 1,
       token_expires_at = excluded.token_expires_at, token_refreshed_at = excluded.token_refreshed_at,
       scopes = excluded.scopes, status = 'active', last_error = NULL, api_version = excluded.api_version,
       connected_at = excluded.connected_at, disconnected_at = NULL, updated_at = excluded.updated_at`,
    igUserId,
    me.data.id ?? null,
    me.data.username ?? null,
    me.data.name ?? null,
    me.data.profile_picture_url ?? null,
    me.data.account_type ?? null,
    enc.ciphertext,
    enc.iv,
    expiresAt,
    now,
    JSON.stringify(scopes),
    env.META_API_VERSION || DEFAULT_API_VERSION,
    now,
    now,
    now,
  );
  const acc = await first<AccountRow>(env.DB, "SELECT * FROM instagram_accounts WHERE ig_user_id = ?", igUserId);
  await subscribeWebhooks(env, acc!.id, token);
  await audit(env.DB, "admin", "account.connected", igUserId, { username: me.data.username, scopes });
  return { ok: true, accountId: acc!.id };
}

export async function subscribeWebhooks(env: Env, accountId: number, token?: string): Promise<{ ok: boolean; error?: string }> {
  const acc = await first<AccountRow>(env.DB, "SELECT * FROM instagram_accounts WHERE id = ?", accountId);
  if (!acc) return { ok: false, error: "no account" };
  const t = token ?? (await getAccessToken(env, env.DB, acc));
  if (!t) return { ok: false, error: "no token" };
  const meta = metaClient(env);
  const r = await meta.subscribeWebhooks(t, WEBHOOK_FIELDS);
  const now = Date.now();
  if (r.ok) {
    await run(env.DB, "UPDATE instagram_accounts SET webhook_status = 'subscribed', webhook_fields = ?, updated_at = ? WHERE id = ?", JSON.stringify(WEBHOOK_FIELDS), now, accountId);
    return { ok: true };
  }
  await run(env.DB, "UPDATE instagram_accounts SET webhook_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?", `webhook subscribe: ${r.error.message}`, now, accountId);
  return { ok: false, error: r.error.message };
}

/** Refreshes long-lived tokens that expire within 15 days (tokens must be ≥ 24h old to refresh). */
export async function refreshExpiringTokens(env: Env): Promise<number> {
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT * FROM instagram_accounts WHERE is_demo = 0 AND status = 'active' AND token_ciphertext IS NOT NULL
       AND (token_expires_at IS NULL OR token_expires_at < ?) AND (token_refreshed_at IS NULL OR token_refreshed_at < ?)`,
  )
    .bind(now + 15 * 86_400_000, now - 86_400_000)
    .all<AccountRow>();
  let n = 0;
  for (const acc of rows.results ?? []) {
    if ((await refreshToken(env, acc)).ok) n++;
  }
  return n;
}

export async function refreshToken(env: Env, acc: AccountRow): Promise<{ ok: boolean; error?: string }> {
  const token = await getAccessToken(env, env.DB, acc);
  if (!token) return { ok: false, error: "no token" };
  const r = await metaClient(env).refreshLongLived(token);
  const now = Date.now();
  if (!r.ok) {
    if (r.error.kind === "auth") await markNeedsReauth(env.DB, acc, r.error.message);
    else await run(env.DB, "UPDATE instagram_accounts SET last_error = ?, updated_at = ? WHERE id = ?", `refresh: ${r.error.message}`, now, acc.id);
    return { ok: false, error: r.error.message };
  }
  const enc = await encryptSecret(r.data.access_token, env.TOKEN_ENC_KEY, aad(acc.ig_user_id));
  await run(
    env.DB,
    "UPDATE instagram_accounts SET token_ciphertext = ?, token_iv = ?, token_expires_at = ?, token_refreshed_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
    enc.ciphertext,
    enc.iv,
    r.data.expires_in ? now + r.data.expires_in * 1000 : null,
    now,
    now,
    acc.id,
  );
  return { ok: true };
}

/**
 * Disconnects the account: stops automation, cancels pending jobs and open flows, deletes the token.
 * With purge=true also removes participants, flows, events and cached media of that account.
 */
export async function disconnectAccount(env: Env, accountId: number, opts: { purge: boolean; actor: string; skipRemote?: boolean }): Promise<void> {
  const acc = await first<AccountRow>(env.DB, "SELECT * FROM instagram_accounts WHERE id = ?", accountId);
  if (!acc) return;
  const now = Date.now();
  if (!opts.skipRemote && !acc.is_demo) {
    const token = await getAccessToken(env, env.DB, acc);
    if (token) await metaClient(env).unsubscribeWebhooks(token).catch(() => undefined);
  }
  const stmts = [
    env.DB.prepare(
      "UPDATE action_jobs SET status = 'cancelled', last_error = 'account disconnected', updated_at = ? WHERE account_id = ? AND status IN ('pending','retry_scheduled')",
    ).bind(now, accountId),
    env.DB.prepare(
      "UPDATE conversation_flows SET state = 'cancelled', state_reason = 'account_disconnected', updated_at = ? WHERE account_id = ? AND state NOT IN ('content_sent','verification_unavailable','expired','failed','cancelled')",
    ).bind(now, accountId),
    env.DB.prepare(
      "UPDATE instagram_accounts SET status = 'disconnected', token_ciphertext = NULL, token_iv = NULL, token_expires_at = NULL, webhook_status = 'not_subscribed', disconnected_at = ?, updated_at = ? WHERE id = ?",
    ).bind(now, now, accountId),
  ];
  if (opts.purge) {
    stmts.push(
      env.DB.prepare("DELETE FROM media_cache WHERE account_id = ?").bind(accountId),
      env.DB.prepare("DELETE FROM conversation_flows WHERE account_id = ?").bind(accountId),
      env.DB.prepare("DELETE FROM participants WHERE account_id = ?").bind(accountId),
      env.DB.prepare("UPDATE webhook_events SET text = NULL, sender_username = NULL, payload = '{}' WHERE account_ig_id = ?").bind(acc.ig_user_id),
    );
  }
  await env.DB.batch(stmts);
  await audit(env.DB, opts.actor, "account.disconnected", acc.ig_user_id, { purge: opts.purge });
}
