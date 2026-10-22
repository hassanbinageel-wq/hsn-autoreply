import type { Env } from "../env";
import { all, getSetting, setSetting } from "../lib/db";
import { menuPayload, type DmMenu } from "../../shared/menu";
import type { AccountRow } from "../engine/context";
import { getAccessToken, metaClient } from "./account";
import { getEntitlement } from "./plans";

/**
 * Puts the customer's ice breakers and persistent menu on their Instagram account(s) through the Messenger Profile
 * endpoint (graph.instagram.com/<IG_ID>/messenger_profile, platform=instagram). Called when the menu is saved; an
 * account is only called again when what it should show changed (Meta limits how often the profile is set).
 */

type Client = Pick<ReturnType<typeof metaClient>, "setMessengerProfile" | "deleteMessengerProfile">;
export interface ProfileDeps {
  client: Client;
  token: (a: AccountRow) => Promise<string | null>;
}
export type ProfileResult = { username: string | null; ok: boolean; error?: string; skipped?: boolean };

/** What Instagram should show (null = nothing), from the saved menu. */
export function profileBody(menu: DmMenu | null, live: boolean) {
  const on = live && !!menu?.enabled;
  const ice = on && menu!.ice_breakers?.length ? [{ locale: "default", call_to_actions: menu!.ice_breakers.map((q) => ({ question: q.question, payload: menuPayload(q.key) })) }] : null;
  const pm = on && menu!.persistent?.length
    ? [{ locale: "default", call_to_actions: menu!.persistent.map((p) => (p.url ? { type: "web_url", title: p.title, url: p.url } : { type: "postback", title: p.title, payload: menuPayload(p.key!) })) }]
    : null;
  return { ice_breakers: ice, persistent_menu: pm };
}

export async function syncMenuProfile(env: Env, tenantId: number, menu: DmMenu | null, deps?: ProfileDeps): Promise<ProfileResult[]> {
  const d: ProfileDeps = deps ?? { client: metaClient(env), token: (a) => getAccessToken(env, env.DB, a) };
  const ent = await getEntitlement(env.DB, tenantId);
  const body = profileBody(menu, ent.owner || (ent.active && !!ent.limits.dm_menu));
  const sig = JSON.stringify(body);
  const synced = await getSetting<Record<string, string>>(env.DB, tenantId, "dm_menu_profile", {});
  const accounts = await all<AccountRow>(env.DB, "SELECT * FROM instagram_accounts WHERE tenant_id = ? AND is_demo = 0 AND status = 'active'", tenantId);
  const out: ProfileResult[] = [];
  for (const a of accounts) {
    const prev = synced[String(a.id)];
    // Never set and nothing to show, or unchanged since last time: no call.
    if (prev === sig || (prev === undefined && !body.ice_breakers && !body.persistent_menu)) {
      out.push({ username: a.username, ok: true, skipped: true });
      continue;
    }
    const token = await d.token(a);
    if (!token) {
      out.push({ username: a.username, ok: false, error: "الحساب يحتاج إعادة ربط" });
      continue;
    }
    const set: Record<string, unknown> = {};
    const del: Array<"ice_breakers" | "persistent_menu"> = [];
    if (body.ice_breakers) set.ice_breakers = body.ice_breakers;
    else del.push("ice_breakers");
    if (body.persistent_menu) set.persistent_menu = body.persistent_menu;
    else del.push("persistent_menu");
    let error: string | undefined;
    if (Object.keys(set).length) {
      const r = await d.client.setMessengerProfile(token, a.ig_user_id, set);
      if (!r.ok) error = r.error.message;
    }
    if (!error && del.length) {
      const r = await d.client.deleteMessengerProfile(token, a.ig_user_id, del);
      if (!r.ok) error = r.error.message;
    }
    if (!error) synced[String(a.id)] = sig;
    out.push({ username: a.username, ok: !error, ...(error ? { error: error.slice(0, 200) } : {}) });
  }
  await setSetting(env.DB, tenantId, "dm_menu_profile", synced);
  return out;
}
