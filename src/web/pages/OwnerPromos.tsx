import { useEffect, useState } from "react";
import { api } from "../api";
import { askConfirm } from "../components/Confirm";
import { DateTimeField } from "../components/DateTimeField";
import { Icon } from "../components/Icon";
import { OfferCard, PopupIcon } from "../components/Promos";
import { logoDataUrl } from "../lib/logoImage";
import { Alert, Card, Field, Modal, Spinner, Toggle, currentTz, fmtTime, toast, useAsync } from "../components/ui";
import { localInputToUtc, utcToLocalInput } from "../lib/tzInput";
import { DEFAULT_TOPUP_SETTINGS, OFFER_LINKS, OFFER_THEMES, type OfferTemplate, type TopupSettings } from "../../shared/promos";

/** Owner panel: message top-up packs (with the out-of-messages window) and offers. */

const n = (v: number) => v.toLocaleString("en-US");

type Pack = { id: number; messages: number; price: number; badge: string | null; plan_ids: string[] | null; active: boolean; sort: number; sold_30d: number };

export function TopupsTab() {
  const { data, loading, error, reload } = useAsync(() => api<any>("/api/owner/topups"), []);
  const [edit, setEdit] = useState<Partial<Pack> | null>(null);
  if (loading && !data) return <Spinner />;
  if (error) return <Alert tone="bad">{error}</Alert>;
  const plans: Array<{ id: string; name: string }> = data.plans ?? [];
  const toggle = async (p: Pack) => {
    try {
      await api(`/api/owner/topups/packs/${p.id}`, { method: "PUT", body: { messages: p.messages, price: p.price, badge: p.badge, plan_ids: p.plan_ids, sort: p.sort, active: !p.active } });
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  return (
    <div className="space-y-5">
      {!data.card && <Alert tone="warn">الدفع بالبطاقة (ميسّر) مو مفعّل — العملاء يشوفون الحزم لكن ما يقدرون يدفعون.</Alert>}
      <Card title="حزم الرسائل الإضافية" action={<button className="btn btn-primary min-h-9 text-sm" onClick={() => setEdit({ messages: 5000, price: 35, badge: null, plan_ids: null, active: true, sort: data.packs.length + 1 })}><Icon name="plus" size={16} />حزمة جديدة</button>}>
        <p className="muted mb-3 text-sm">العميل يشتري حزمة لما تقرب رسائل دورته تخلص. الرسائل تنضاف لدورته الحالية وتنصرف بعد رسائل باقته، وتنتهي مع تجدد العدّاد.</p>
        {!data.packs.length ? (
          <p className="muted py-4 text-center text-sm">ما فيه حزم — أضف أول حزمة.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="muted text-xs"><tr><th className="p-2 text-right">الرسائل</th><th className="p-2 text-right">السعر</th><th className="p-2 text-right">الشارة</th><th className="p-2 text-right">متاحة لـ</th><th className="p-2 text-right">مبيعات 30 يوم</th><th className="p-2 text-right">مفعّلة</th><th /></tr></thead>
              <tbody>
                {data.packs.map((p: Pack) => (
                  <tr key={p.id} className="border-t border-[var(--border)]">
                    <td className="p-2 font-bold tabular-nums">{n(p.messages)}</td>
                    <td className="p-2 tabular-nums">{n(p.price)} ر.س <span className="muted text-xs">({Math.round((p.price / p.messages) * 100_000) / 100} لكل ألف)</span></td>
                    <td className="p-2">{p.badge || <span className="muted">—</span>}</td>
                    <td className="p-2">{p.plan_ids?.length ? p.plan_ids.map((id) => plans.find((x) => x.id === id)?.name ?? id).join("، ") : "كل الباقات"}</td>
                    <td className="p-2 tabular-nums">{p.sold_30d}</td>
                    <td className="p-2"><Toggle checked={p.active} onChange={() => toggle(p)} label="" /></td>
                    <td className="p-2"><button className="btn btn-ghost min-h-9 px-3 text-xs" onClick={() => setEdit(p)}>تعديل</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {edit && <PackModal pack={edit} plans={plans} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
      <TopupSettingsCard initial={data.settings} />
      <Card title="آخر عمليات الشحن">
        {!data.sales.length ? <p className="muted py-3 text-center text-sm">ما فيه عمليات بعد.</p> : (
          <div className="divide-y divide-[var(--border)] text-sm">
            {data.sales.map((s: any) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><b>{s.tenant_name ?? `#${s.tenant_id}`}</b> · {n(s.messages)} رسالة</span>
                <span className="muted text-xs">{s.source === "card" ? `${n(s.amount / 100)} ر.س` : "🎁 إهداء منك"} · {fmtTime(s.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function PackModal({ pack, plans, onClose, onDone }: { pack: Partial<Pack>; plans: Array<{ id: string; name: string }>; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ messages: pack.messages ?? 5000, price: pack.price ?? 35, badge: pack.badge ?? "", plan_ids: pack.plan_ids ?? [], active: pack.active ?? true, sort: pack.sort ?? 0 });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...f, badge: f.badge.trim() || null, plan_ids: f.plan_ids.length ? f.plan_ids : null };
      await api(pack.id ? `/api/owner/topups/packs/${pack.id}` : "/api/owner/topups/packs", { method: pack.id ? "PUT" : "POST", body });
      toast("انحفظت الحزمة");
      onDone();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    if (!(await askConfirm({ title: "حذف الحزمة؟", message: "اللي اشتروها قبل تبقى رسائلهم.", confirmLabel: "حذف", danger: true }))) return;
    try {
      await api(`/api/owner/topups/packs/${pack.id}`, { method: "DELETE" });
      onDone();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  return (
    <Modal open onClose={onClose} title={pack.id ? "تعديل الحزمة" : "حزمة جديدة"} center>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="عدد الرسائل"><input className="input" type="number" min={100} value={f.messages} onChange={(e) => setF({ ...f, messages: +e.target.value })} /></Field>
          <Field label="السعر (ر.س)" hint="شامل الضريبة"><input className="input" type="number" min={1} step="0.5" value={f.price} onChange={(e) => setF({ ...f, price: +e.target.value })} /></Field>
        </div>
        <Field label="الشارة (اختياري)" hint="مثل: الأكثر طلبًا، الأوفر"><input className="input" maxLength={30} value={f.badge} onChange={(e) => setF({ ...f, badge: e.target.value })} /></Field>
        <Field label="متاحة لباقات" hint="بدون اختيار = كل الباقات">
          <div className="flex flex-wrap gap-1.5">
            {plans.map((p) => {
              const on = f.plan_ids.includes(p.id);
              return <button key={p.id} type="button" className={`chip ${on ? "bg-violet-500/15 text-violet-700 dark:text-violet-300" : "surface-2"}`} onClick={() => setF({ ...f, plan_ids: on ? f.plan_ids.filter((x) => x !== p.id) : [...f.plan_ids, p.id] })}>{on ? "✓ " : ""}{p.name}</button>;
            })}
          </div>
        </Field>
        <Field label="الترتيب"><input className="input" type="number" min={0} value={f.sort} onChange={(e) => setF({ ...f, sort: +e.target.value })} /></Field>
        <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="مفعّلة (تظهر للعملاء)" />
        <div className="flex justify-between gap-2">
          {pack.id ? <button className="btn btn-ghost text-red-600" onClick={del}>حذف</button> : <span />}
          <span className="flex gap-2"><button className="btn btn-ghost" onClick={onClose}>إلغاء</button><button className="btn btn-primary" disabled={busy || f.messages < 100 || f.price < 1} onClick={save}>{busy ? "…" : "حفظ"}</button></span>
        </div>
      </div>
    </Modal>
  );
}

function TopupSettingsCard({ initial }: { initial: TopupSettings }) {
  const [s, setS] = useState<TopupSettings>(initial);
  const [busy, setBusy] = useState(false);
  const pop = (k: keyof TopupSettings["popup"], v: string | boolean | null) => setS({ ...s, popup: { ...s.popup, [k]: v } });
  const save = async () => {
    setBusy(true);
    try {
      await api("/api/owner/topups/settings", { method: "PUT", body: s });
      toast("انحفظت الإعدادات");
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="الإعدادات ونافذة «خلصت الرسائل»">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="حد الشحن بالدورة" hint="لكل عميل">
              <select className="input" value={s.max_per_cycle} onChange={(e) => setS({ ...s, max_per_cycle: +e.target.value })}>
                {[0, 1, 2, 3, 5, 10].map((v) => <option key={v} value={v}>{v === 0 ? "بدون حد" : `${v} مرات`}</option>)}
              </select>
            </Field>
          </div>
          <Field label="تنبيهات الجرس عند استهلاك" hint="كل نسبة يوصله عندها إشعار مرة وحدة بالدورة — و100% (خلصت) ترسل رسالة «خلصت الرسائل» دايم">
            <div className="flex flex-wrap gap-1.5">
              {[50, 60, 70, 75, 80, 85, 90, 95].map((v) => {
                const on = s.alert_steps.includes(v);
                return <button key={v} type="button" className={`chip ${on ? "bg-violet-500/15 text-violet-700 dark:text-violet-300" : "surface-2"}`} onClick={() => setS({ ...s, alert_steps: (on ? s.alert_steps.filter((x) => x !== v) : [...s.alert_steps, v]).sort((a, b) => a - b) })}>{on ? "✓ " : ""}{v}%</button>;
              })}
              <span className="chip bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">✓ 100%</span>
            </div>
          </Field>
          <Toggle checked={s.popup.enabled} onChange={(v) => pop("enabled", v)} label="نافذة في وسط الشاشة" description="تطلع مرة باليوم ما دام استهلاكه فوق النسبة اللي تحددها." />
          <div className="grid grid-cols-2 gap-3">
            <Field label="تظهر عند استهلاك">
              <select className="input" value={s.popup.show_at} onChange={(e) => setS({ ...s, popup: { ...s.popup, show_at: +e.target.value } })}>
                {[70, 80, 85, 90, 95, 100].map((v) => <option key={v} value={v}>{v === 100 ? "لما تخلص (100%)" : `${v}%`}</option>)}
              </select>
            </Field>
            <Field label="بعد فتح التطبيق بـ">
              <select className="input" value={s.popup.delay_min} onChange={(e) => setS({ ...s, popup: { ...s.popup, delay_min: +e.target.value } })}>
                {[0, 1, 2, 3, 5, 10, 15, 30, 60].map((v) => <option key={v} value={v}>{v === 0 ? "على طول" : `${v} دقيقة`}</option>)}
              </select>
            </Field>
          </div>
          <Field label="الأيقونة" hint="PNG أو JPG أو WEBP — تنعرض مربعة">
            <div className="flex items-center gap-3">
              <PopupIcon src={s.popup.icon} />
              <label className="btn btn-ghost min-h-9 cursor-pointer text-sm">
                رفع صورة
                <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; try { pop("icon", await logoDataUrl(f, 192)); } catch (err: any) { toast(err.message, "bad"); } }} />
              </label>
              {s.popup.icon && <button type="button" className="btn btn-ghost min-h-9 text-sm" onClick={() => pop("icon", null)}>الافتراضية</button>}
            </div>
          </Field>
          <Field label="العنوان"><input className="input" maxLength={80} value={s.popup.title} onChange={(e) => pop("title", e.target.value)} /></Field>
          <Field label="النص"><textarea className="input min-h-[6rem]" maxLength={400} value={s.popup.body} onChange={(e) => pop("body", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="زر الشراء"><input className="input" maxLength={30} value={s.popup.cta} onChange={(e) => pop("cta", e.target.value)} /></Field>
            <Field label="زر الإلغاء"><input className="input" maxLength={20} value={s.popup.cancel} onChange={(e) => pop("cancel", e.target.value)} /></Field>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? "…" : "حفظ"}</button>
            <button className="btn btn-ghost" onClick={() => setS(DEFAULT_TOPUP_SETTINGS)}>النص الافتراضي</button>
          </div>
        </div>
        <div>
          <span className="muted mb-2 block text-xs">معاينة النافذة كما يشوفها العميل:</span>
          <div className="surface-2 rounded-3xl p-5">
            <div className="card mx-auto max-w-sm space-y-3 p-5 text-center">
              <PopupIcon src={s.popup.icon} />
              <b className="font-display block text-lg">{s.popup.title}</b>
              <p className="muted whitespace-pre-line text-sm">{s.popup.body}</p>
              <div className="flex gap-2"><span className="btn btn-primary flex-1"><Icon name="zap" size={16} />{s.popup.cta}</span><span className="btn btn-ghost">{s.popup.cancel}</span></div>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---- Offers

type Audience = "all" | "plans" | "except_plans" | "tenants";
type OfferForm = {
  id?: number; title: string; body: string; cta: string; link: string; custom_link: string; theme: string; icon: string; starts_at: number | null; ends_at: number | null;
  audience: Audience; tenant_ids: number[]; plan_ids: string[]; discount_pct: number | null; discount_plans: string[]; active: boolean;
};
const EMPTY_OFFER: OfferForm = { title: "", body: "", cta: "استفد الحين", link: "/subscription", custom_link: "", theme: "violet", icon: "🎁", starts_at: null, ends_at: null, audience: "all", tenant_ids: [], plan_ids: [], discount_pct: null, discount_plans: [], active: true };
const AUDIENCES: Array<[Audience, string]> = [["all", "كل العملاء"], ["plans", "مشتركين باقات"], ["except_plans", "الكل ماعدا باقات"], ["tenants", "عملاء أختارهم"]];

/** Who an offer is for, in words (cards and details). */
export function audienceText(o: { audience: string; tenant_ids: number[]; plan_ids: string[] }, plans: Array<{ id: string; name: string }>): string {
  const names = (o.plan_ids ?? []).map((id) => plans.find((p) => p.id === id)?.name ?? id).join("، ");
  return o.audience === "all" ? "كل العملاء" : o.audience === "tenants" ? `${o.tenant_ids.length} عميل مختار` : o.audience === "plans" ? `مشتركين: ${names}` : `الكل ماعدا: ${names}`;
}
const ICONS = ["🎁", "🔥", "⚡", "🚀", "💜", "⭐", "🎉", "💰", "📣", "⏳"];

export function OffersTab() {
  const { data, loading, error, reload } = useAsync(() => api<any>("/api/owner/offers"), []);
  const [edit, setEdit] = useState<OfferForm | null>(null);
  const [statsFor, setStatsFor] = useState<any | null>(null);
  const { data: plans } = useAsync(() => api<Array<{ id: string; name: string }>>("/api/owner/plans"), []);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (loading && !data) return <Spinner />;
  if (error) return <Alert tone="bad">{error}</Alert>;
  const status = (o: any) => (!o.active ? ["موقوف", "surface-2 muted"] : o.ends_at <= now ? ["انتهى", "surface-2 muted"] : o.starts_at && o.starts_at > now ? ["مجدول", "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300"] : ["يظهر الحين", "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"]);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="muted text-sm">بوكس جانبي بحركة وعدّاد تنازلي يظهر لكل العملاء أو لعملاء تختارهم، ولما يضغطون يروحون للمكان اللي تحدده.</p>
        <button className="btn btn-primary" onClick={() => setEdit({ ...EMPTY_OFFER, ends_at: Date.now() + 3 * 86_400_000 })}><Icon name="plus" size={18} />عرض جديد</button>
      </div>
      {!data.offers.length ? <Card><p className="muted py-6 text-center text-sm">ما فيه عروض بعد.</p></Card> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.offers.map((o: any) => {
            const [l, cls] = status(o);
            return (
              <Card key={o.id} className="self-start">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <span className={`chip ${cls}`}>{l}</span>
                  <span className="muted text-xs">{audienceText(o, plans ?? [])}{o.discount_pct ? ` · خصم ${o.discount_pct}%` : ""} · {o.clicks} ضغطة</span>
                </div>
                <OfferCard o={o} now={now} />
                <div className="mt-3 flex justify-end gap-2">
                  <button className="btn btn-ghost min-h-9 text-xs" onClick={() => setStatsFor(o)}><Icon name="chart" size={15} />التفاصيل والتحليل</button>
                  <button className="btn btn-ghost min-h-9 text-xs" onClick={() => setEdit({ ...EMPTY_OFFER, ...o, discount_pct: o.discount_pct ?? null, body: o.body ?? "", cta: o.cta ?? "", icon: o.icon ?? "", link: OFFER_LINKS.some((x) => x.to === o.link) ? o.link : "custom", custom_link: OFFER_LINKS.some((x) => x.to === o.link) ? "" : o.link })}>تعديل</button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {edit && <OfferModal offer={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
      {statsFor && <OfferStatsModal offer={statsFor} plans={plans ?? []} onClose={() => setStatsFor(null)} />}
    </div>
  );
}

function OfferModal({ offer, onClose, onDone }: { offer: OfferForm; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<OfferForm>(offer);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const { data: tenants } = useAsync(() => api<any[]>("/api/owner/tenants"), []);
  const { data: plans } = useAsync(() => api<Array<{ id: string; name: string; active: number }>>("/api/owner/plans"), []);
  const planChips = (sel: string[], onChange: (v: string[]) => void) => (
    <div className="flex flex-wrap gap-1.5">
      {(plans ?? []).filter((p) => p.active).map((p) => {
        const on = sel.includes(p.id);
        return <button key={p.id} type="button" className={`chip ${on ? "bg-violet-500/15 text-violet-700 dark:text-violet-300" : "surface-2"}`} onClick={() => onChange(on ? sel.filter((x) => x !== p.id) : [...sel, p.id])}>{on ? "✓ " : ""}{p.name}</button>;
      })}
    </div>
  );
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const tz = currentTz();
  const set = (p: Partial<OfferForm>) => setF((x) => ({ ...x, ...p }));
  const customers = (tenants ?? []).filter((t) => !t.is_owner);
  const shown = q ? customers.filter((t) => `${t.name} ${t.username ?? ""} ${t.ig_username ?? ""}`.toLowerCase().includes(q.toLowerCase())) : customers;
  const save = async () => {
    if (!f.ends_at) return toast("حدد وقت انتهاء العرض", "bad");
    setBusy(true);
    try {
      const body = {
        title: f.title, body: f.body || null, cta: f.cta || null, link: f.link === "custom" ? f.custom_link.trim() : f.link, theme: f.theme, icon: f.icon || null,
        starts_at: f.starts_at, ends_at: f.ends_at, audience: f.audience, tenant_ids: f.audience === "tenants" ? f.tenant_ids : undefined,
        plan_ids: f.audience === "plans" || f.audience === "except_plans" ? f.plan_ids : undefined,
        discount_pct: f.discount_pct || null, discount_plans: f.discount_pct ? f.discount_plans : null, active: f.active,
      };
      await api(f.id ? `/api/owner/offers/${f.id}` : "/api/owner/offers", { method: f.id ? "PUT" : "POST", body });
      toast(f.id ? "انحفظ العرض" : "انضاف العرض");
      onDone();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    if (!(await askConfirm({ title: "حذف العرض؟", confirmLabel: "حذف", danger: true }))) return;
    try {
      await api(`/api/owner/offers/${f.id}`, { method: "DELETE" });
      onDone();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  return (
    <Modal open onClose={onClose} title={f.id ? "تعديل العرض" : "عرض جديد"}>
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-3">
          <OfferTemplates current={f} onPick={(t) => set({ title: t.title, body: t.body, cta: t.cta, link: OFFER_LINKS.some((x) => x.to === t.link) ? t.link : "custom", custom_link: OFFER_LINKS.some((x) => x.to === t.link) ? "" : t.link, theme: t.theme, icon: t.icon, ends_at: Date.now() + t.days * 86_400_000 })} />
          <Field label="العنوان"><input className="input" maxLength={60} value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="مثل: خصم 30% على الاحترافية" /></Field>
          <Field label="التفاصيل (اختياري)"><textarea className="input min-h-[4.5rem]" maxLength={200} value={f.body} onChange={(e) => set({ body: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="نص الزر"><input className="input" maxLength={24} value={f.cta} onChange={(e) => set({ cta: e.target.value })} /></Field>
            <Field label="يوصله إلى">
              <select className="input" value={f.link} onChange={(e) => set({ link: e.target.value })}>
                {OFFER_LINKS.map((l) => <option key={l.to} value={l.to}>{l.label}</option>)}
                <option value="custom">رابط خارجي…</option>
              </select>
            </Field>
          </div>
          {f.link === "custom" && <Field label="الرابط" hint="يبدأ بـ https://"><input className="input" dir="ltr" value={f.custom_link} onChange={(e) => set({ custom_link: e.target.value })} placeholder="https://" /></Field>}
          <Field label="التصميم">
            <div className="flex flex-wrap gap-2">
              {Object.entries(OFFER_THEMES).map(([k, t]) => (
                <button key={k} type="button" onClick={() => set({ theme: k })} title={t.label} aria-label={t.label} className={`h-10 w-16 rounded-xl border-2 ${f.theme === k ? "border-[var(--fg)] ring-2 ring-violet-400" : "border-transparent"}`} style={{ background: t.bg }} />
              ))}
            </div>
          </Field>
          <Field label="الأيقونة">
            <div className="flex flex-wrap gap-1.5">
              {ICONS.map((i) => <button key={i} type="button" onClick={() => set({ icon: i })} className={`flex h-10 w-10 items-center justify-center rounded-xl text-xl ${f.icon === i ? "bg-violet-500/15 ring-2 ring-violet-400" : "surface-2"}`}>{i}</button>)}
              <button type="button" onClick={() => set({ icon: "" })} className={`h-10 rounded-xl px-3 text-xs ${!f.icon ? "bg-violet-500/15 ring-2 ring-violet-400" : "surface-2"}`}>بدون</button>
            </div>
          </Field>
          <div className="grid gap-3">
            <Field label="يبدأ" hint="فاضي = من الحين"><DateTimeField label="بداية العرض" emptyLabel="من الحين" value={utcToLocalInput(f.starts_at, tz)} onChange={(v) => set({ starts_at: localInputToUtc(v, tz) })} /></Field>
            <Field label="ينتهي" hint="العدّاد ينزل لهذا الوقت"><DateTimeField label="نهاية العرض" clearable={false} value={utcToLocalInput(f.ends_at, tz)} onChange={(v) => set({ ends_at: localInputToUtc(v, tz) })} /></Field>
          </div>
          <Field label="يظهر لـ">
            <div className="mb-2 flex flex-wrap gap-1.5" role="radiogroup">
              {AUDIENCES.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={f.audience === k} className={`chip ${f.audience === k ? "grad text-white" : "surface-2"}`} onClick={() => set({ audience: k })}>{l}</button>)}
            </div>
            {(f.audience === "plans" || f.audience === "except_plans") && (
              <div className="space-y-1">
                <span className="muted text-xs">{f.audience === "plans" ? "يظهر للمشتركين في:" : "يظهر للكل ماعدا المشتركين في:"}</span>
                {planChips(f.plan_ids, (v) => set({ plan_ids: v }))}
              </div>
            )}
            {f.audience === "tenants" && (
              <div className="space-y-2">
                <input className="input" type="search" placeholder="ابحث عن عميل" value={q} onChange={(e) => setQ(e.target.value)} />
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl border border-[var(--border)] p-2">
                  {!tenants ? <Spinner /> : shown.map((t) => {
                    const on = f.tenant_ids.includes(t.id);
                    return (
                      <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--surface-2)]">
                        <input type="checkbox" checked={on} onChange={() => set({ tenant_ids: on ? f.tenant_ids.filter((x) => x !== t.id) : [...f.tenant_ids, t.id] })} />
                        {t.name}<span className="muted text-xs">{t.plan_name ?? ""}</span>
                      </label>
                    );
                  })}
                </div>
                <p className="muted text-xs">{f.tenant_ids.length} مختار</p>
              </div>
            )}
          </Field>
          <div className="surface-2 space-y-2 rounded-2xl p-3">
            <Toggle checked={!!f.discount_pct} onChange={(v) => set({ discount_pct: v ? 30 : null })} label="خصم فعلي عند الدفع" description="ينخصم من سعر البطاقة والترقية تلقائيًا — بس للعملاء اللي يظهر لهم هذا العرض، ولين ينتهي." />
            {!!f.discount_pct && (
              <>
                <Field label="نسبة الخصم %"><input className="input w-28" type="number" min={1} max={90} value={f.discount_pct} onChange={(e) => set({ discount_pct: Math.max(1, Math.min(90, +e.target.value || 1)) })} /></Field>
                <div className="space-y-1">
                  <span className="muted text-xs">على باقات (بدون اختيار = كل الباقات):</span>
                  {planChips(f.discount_plans, (v) => set({ discount_plans: v }))}
                </div>
              </>
            )}
          </div>
          <Toggle checked={f.active} onChange={(v) => set({ active: v })} label="مفعّل" />
        </div>
        <div className="md:sticky md:top-0 md:self-start">
          <span className="muted mb-2 block text-xs">معاينة حيّة:</span>
          <OfferCard o={{ title: f.title || "عنوان العرض", body: f.body || null, cta: f.cta || null, theme: f.theme, icon: f.icon || null, ends_at: f.ends_at ?? now + 86_400_000 }} now={now} />
        </div>
      </div>
      <div className="mt-4 flex justify-between gap-2">
        {f.id ? <button className="btn btn-ghost text-red-600" onClick={del}>حذف</button> : <span />}
        <span className="flex gap-2"><button className="btn btn-ghost" onClick={onClose}>إلغاء</button><button className="btn btn-primary" disabled={busy || f.title.trim().length < 2} onClick={save}>{busy ? "…" : "حفظ"}</button></span>
      </div>
    </Modal>
  );
}

/** Ready offer contents: pick one to fill the form, save the current one, or remove one. */
function OfferTemplates({ current, onPick }: { current: OfferForm; onPick: (t: OfferTemplate) => void }) {
  const [list, setList] = useState<OfferTemplate[] | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => { api<{ templates: OfferTemplate[] }>("/api/owner/offer-templates").then((d) => setList(d.templates)).catch(() => setList([])); }, []);
  const persist = async (next: OfferTemplate[], msg: string) => {
    try {
      await api("/api/owner/offer-templates", { method: "PUT", body: next });
      setList(next);
      toast(msg);
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  if (!list) return <Spinner />;
  const saveCurrent = () => {
    if (current.title.trim().length < 2) return toast("اكتب العنوان أول", "bad");
    const link = current.link === "custom" ? current.custom_link.trim() : current.link;
    const days = current.ends_at ? Math.max(1, Math.min(90, Math.round((current.ends_at - Date.now()) / 86_400_000))) : 3;
    const t: OfferTemplate = { label: current.title.trim().slice(0, 40), title: current.title.trim(), body: current.body.trim(), cta: current.cta.trim(), link, theme: current.theme, icon: current.icon, days };
    persist([...list.filter((x) => x.label !== t.label), t], "انحفظ كقالب");
  };
  return (
    <div className="surface-2 space-y-2 rounded-2xl p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="muted text-xs">قوالب جاهزة — اضغط واحد يتعبّى وعدّل عليه:</span>
        <span className="flex shrink-0 gap-1">
          <button type="button" className="btn btn-ghost min-h-8 px-2 text-[11px]" onClick={saveCurrent}>💾 حفظ كقالب</button>
          <button type="button" className="btn btn-ghost min-h-8 px-2 text-[11px]" onClick={() => setEditing((v) => !v)}>{editing ? "تم" : "✏️ تعديل"}</button>
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {list.map((t) => (
          <span key={t.label} className="chip bg-[var(--surface)]">
            <button type="button" onClick={() => onPick(t)}>{t.icon} {t.label}</button>
            {editing && <button type="button" aria-label={`حذف ${t.label}`} className="mr-1 text-red-600" onClick={() => persist(list.filter((x) => x.label !== t.label), "انحذف القالب")}>✕</button>}
          </span>
        ))}
        {!list.length && <span className="muted text-xs">ما فيه قوالب.</span>}
      </div>
      {editing && <p className="muted text-[11px]">لتعديل قالب: اختره، عدّل الحقول، ثم «حفظ كقالب» بنفس العنوان.</p>}
    </div>
  );
}

/** One offer's numbers: for how many, who saw it, who opened it, who paid after it. */
function OfferStatsModal({ offer, plans, onClose }: { offer: any; plans: Array<{ id: string; name: string }>; onClose: () => void }) {
  const { data, loading, error } = useAsync(() => api<any>(`/api/owner/offers/${offer.id}/stats`), [offer.id]);
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
  return (
    <Modal open onClose={onClose} title={`تفاصيل «${offer.title}»`}>
      {loading && !data ? <Spinner /> : error ? <Alert tone="bad">{error}</Alert> : (
        <div className="space-y-4">
          <p className="muted text-sm">{audienceText(offer, plans)}{offer.discount_pct ? ` · خصم فعلي ${offer.discount_pct}%` : ""} · {offer.ends_at > Date.now() ? `ينتهي ${fmtTime(offer.ends_at)}` : `انتهى ${fmtTime(offer.ends_at)}`}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {[["المستهدفين", n(data.targeted), ""], ["شافوه", n(data.viewed), pct(data.viewed, data.targeted)], ["ضغطوا", n(data.clicked), pct(data.clicked, data.viewed)], ["اشتروا بعده", n(data.converted), pct(data.converted, data.viewed)], ["الإيراد", `${n(data.revenue)} ر.س`, ""]].map(([l, v, sub]) => (
              <div key={l} className="surface-2 rounded-xl p-3 text-center">
                <div className="muted text-xs">{l}</div>
                <div className="font-display text-xl font-extrabold tabular-nums">{v}</div>
                {sub && <div className="muted text-[11px]">{sub}</div>}
              </div>
            ))}
          </div>
          <p className="muted text-xs">«اشتروا بعده» = دفعوا بالبطاقة (باقة أو ترقية أو رسائل إضافية) أو فعّلوا كود بعد ما شافوا العرض ولين 3 أيام بعد انتهائه.</p>
          {!data.people.length ? <p className="muted py-4 text-center text-sm">ما أحد شاف العرض بعد — يظهر للعميل أول ما يفتح التطبيق أو يتنقّل فيه.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="muted text-xs"><tr><th className="p-2 text-right">العميل</th><th className="p-2 text-right">شافه</th><th className="p-2 text-right">ضغط</th><th className="p-2 text-right">اشترى</th></tr></thead>
                <tbody>
                  {data.people.map((p: any) => (
                    <tr key={p.tenant_id} className="border-t border-[var(--border)]">
                      <td className="p-2 font-bold">{p.name}</td>
                      <td className="p-2 text-xs">{p.viewed_at ? fmtTime(p.viewed_at) : "—"}</td>
                      <td className="p-2 text-xs">{p.clicked_at ? fmtTime(p.clicked_at) : <span className="muted">لا</span>}</td>
                      <td className="p-2 text-xs">{p.bought.length ? p.bought.map((b: any, i: number) => <div key={i} className="font-semibold text-emerald-700 dark:text-emerald-400">✓ {b.what}{b.amount ? ` · ${n(b.amount)} ر.س` : ""}</div>) : <span className="muted">لا</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
