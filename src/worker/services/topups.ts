import type { Env } from "../env";
import { all, audit, first, getSetting, OWNER_TENANT, run, setSetting } from "../lib/db";
import { topupSettingsOf, type TopupSettings } from "../../shared/promos";
import { notify } from "./notify";
import { getEntitlement, monthlyMessages, usageCycle } from "./plans";
import { cardEnabled, createInvoice, isTestKey, PayError } from "./moyasar";

/**
 * Message top-ups: when a customer's cycle messages run out (or nearly), they buy a pack the owner sells. The pack
 * is added to the current usage cycle (getEntitlement adds it to the cycle's limit), so it lasts until the counter
 * renews and is used after the plan's own messages. Paid by card through Moyasar like plans.
 */

export type TopupPack = { id: number; messages: number; price: number; badge: string | null; plan_ids: string[] | null; active: boolean; sort: number };
type PackRow = { id: number; messages: number; price_halalas: number; badge: string | null; plan_ids: string | null; active: number; sort: number };

const toPack = (r: PackRow): TopupPack => ({ id: r.id, messages: r.messages, price: r.price_halalas / 100, badge: r.badge, plan_ids: r.plan_ids ? (JSON.parse(r.plan_ids) as string[]) : null, active: !!r.active, sort: r.sort });

export async function topupSettings(db: D1Database): Promise<TopupSettings> {
  return topupSettingsOf(await getSetting<Partial<TopupSettings> | null>(db, OWNER_TENANT, "topup_settings", null));
}

export async function allPacks(db: D1Database): Promise<TopupPack[]> {
  return (await all<PackRow>(db, "SELECT * FROM topup_packs ORDER BY sort, messages")).map(toPack);
}

/** Packs a customer on `planId` can buy now. */
export async function packsFor(db: D1Database, planId: string | null): Promise<TopupPack[]> {
  return (await allPacks(db)).filter((p) => p.active && planId && (!p.plan_ids || p.plan_ids.includes(planId)));
}

/** Where a customer stands this cycle, and whether (and what) they may buy. */
export async function topupState(env: Env, tenantId: number, now = Date.now()) {
  const ent = await getEntitlement(env.DB, tenantId, now);
  const settings = await topupSettings(env.DB);
  const cy = await usageCycle(env.DB, tenantId, now);
  const used = await monthlyMessages(env.DB, tenantId, now);
  const limit = ent.limits.monthly_messages;
  const extra = ent.extra_messages ?? 0;
  const bought = await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM message_credits WHERE tenant_id = ? AND cycle_key = ? AND source = 'card'", tenantId, cy.key);
  const packs = ent.active && !ent.owner && limit !== null ? await packsFor(env.DB, ent.plan?.id ?? null) : [];
  const capped = settings.max_per_cycle > 0 && (bought?.n ?? 0) >= settings.max_per_cycle;
  const out = limit !== null && used >= limit;
  return {
    used,
    limit,
    plan_limit: limit === null ? null : limit - extra,
    extra,
    out,
    resets_at: cy.resets_at,
    cycle_key: cy.key,
    purchases: bought?.n ?? 0,
    packs,
    card: cardEnabled(env),
    // The button shows from the owner's threshold; buying is open while the plan is active and the cap not reached.
    show: packs.length > 0 && limit !== null && limit > 0 && used / limit >= settings.show_at_pct / 100,
    can_buy: packs.length > 0 && cardEnabled(env) && !capped,
    capped,
    settings,
  };
}

/** Opens the payment page for one pack (account holder of an active, limited plan). */
export async function startTopup(env: Env, tenantId: number, packId: number, actor: string, siteOrigin?: string, now = Date.now()): Promise<{ id: number; url: string; messages: number; amount: number }> {
  const st = await topupState(env, tenantId, now);
  if (!st.card) throw new PayError("card_off", "الدفع بالبطاقة غير متاح حاليًا", 409);
  const pack = st.packs.find((p) => p.id === packId);
  if (!pack) throw new PayError("not_found", "هذي الحزمة غير متاحة لباقتك", 404);
  if (st.capped) throw new PayError("capped", `وصلت الحد (${st.settings.max_per_cycle}) لشحن الرسائل في هذي الدورة — رقّ باقتك أو انتظر تجدد العدّاد`, 409);
  const ent = await getEntitlement(env.DB, tenantId, now);
  const amount = Math.round(pack.price * 100);
  const r = await createInvoice(
    env,
    { tenantId, planId: ent.plan!.id, days: 0, amount, description: `شيّك — ${pack.messages.toLocaleString("en-US")} رسالة إضافية`, actor, siteOrigin, topup: { packId: pack.id, messages: pack.messages } },
    now,
  );
  return { ...r, messages: pack.messages, amount: pack.price };
}

/**
 * Adds messages to the customer's current cycle (a paid pack, or a gift from the owner) and lets the usage alerts
 * fire again when the new messages run out.
 */
export async function applyTopup(env: Env, o: { tenantId: number; messages: number; packId?: number | null; paymentId?: number | null; amount?: number; actor?: string }, now = Date.now()): Promise<void> {
  const cy = await usageCycle(env.DB, o.tenantId, now);
  const source = o.paymentId ? "card" : "owner";
  await run(
    env.DB,
    "INSERT INTO message_credits (tenant_id, cycle_key, messages, pack_id, payment_id, amount, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    o.tenantId, cy.key, o.messages, o.packId ?? null, o.paymentId ?? null, o.amount ?? 0, source, o.actor ?? (o.paymentId ? `payment:${o.paymentId}` : "owner"), now,
  );
  await setSetting(env.DB, o.tenantId, `plan_alert_messages_${cy.key}`, 0);
  const n = o.messages.toLocaleString("en-US");
  await audit(env.DB, o.tenantId, o.actor ?? "moyasar", "subscription.topup", String(o.messages), { payment: o.paymentId ?? null, amount: o.amount ?? 0, cycle: cy.key });
  if (o.paymentId) {
    const sar = ((o.amount ?? 0) / 100).toLocaleString("en-US");
    const t = await first<{ name: string }>(env.DB, "SELECT name FROM tenants WHERE id = ?", o.tenantId);
    await notify(env, o.tenantId, "plan", `✅ تم الشحن: انضافت ${n} رسالة لرصيدك (${sar} ر.س)، وتصلح لين يتجدد العدّاد.`, undefined, { link: "/subscription" });
    await notify(env, OWNER_TENANT, "plan", `💳 شحن رسائل: «${t?.name ?? o.tenantId}» اشترى ${n} رسالة بـ ${sar} ر.س${isTestKey(env) ? " (تجريبي)" : ""}`, undefined, { link: "/owner?tab=topups" });
  } else {
    await notify(env, o.tenantId, "plan", `🎁 أضفنا لك ${n} رسالة على رصيد هذي الدورة.`, undefined, { link: "/subscription" });
  }
}

/** This cycle's top-ups of one customer, newest first (their own history). */
export async function topupHistory(db: D1Database, tenantId: number) {
  return all<{ id: number; messages: number; amount: number; source: string; created_at: number }>(
    db,
    "SELECT id, messages, amount, source, created_at FROM message_credits WHERE tenant_id = ? ORDER BY id DESC LIMIT 20",
    tenantId,
  );
}
