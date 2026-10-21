import { MESSAGE_LINKS } from "../../shared/plans";
import { OwnerSupportTab } from "./Support";
import { PlaceholderChips, TemplateBar } from "../components/MessageTemplates";
import { DiagnoseModal } from "../components/Diagnose";
import { hasPerm } from "../lib/me";
import { normText } from "../lib/text";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { DateTimeField } from "../components/DateTimeField";
import { askConfirm, askText, showCopy } from "../components/Confirm";
import { api } from "../api";
import { API_BASE } from "../platform";
import { BANNER_SIZES, DEFAULT_TEXTS, DesktopBanner, MobileBanner, PointIcon, toCm, type BannerTexts, type Branding } from "../components/LoginBanner";
import { remixExists, remixName } from "../components/RemixIcon";
import { Icon } from "../components/Icon";
import { Alert, Card, Empty, Field, Modal, Spinner, Tip, Toggle, fmtDate, fmtTime, toast, useAsync } from "../components/ui";
import { CURRENCIES, EVENT_LABELS, FEATURE_HINTS, FEATURE_LABELS, LIMIT_HINTS, LIMIT_ROW_LABELS, PRICE_PERIODS, formatPrice, orderFeatures } from "../../shared/plans";

const TABS = [["customers", "العملاء"], ["health", "صحة العملاء"], ["support", "الدعم"], ["plans", "الباقات"], ["codes", "أكواد التفعيل"], ["coupons", "الكوبونات والإحالة"], ["payments", "الدفع"], ["branding", "صفحة الدخول"]] as const;
/** Which staff section opens each tab (the account holder sees all). */
const TAB_PERM: Record<(typeof TABS)[number][0], string> = { customers: "owner_customers", health: "owner_customers", support: "owner_support", plans: "owner_plans", codes: "owner_plans", coupons: "owner_plans", payments: "owner_payments", branding: "owner_branding" };

/** A random 16-character password (the owner gives it to the customer, who can change it later). */
function generatePassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function NewCustomer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState(generatePassword);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null);
  const submit = async () => {
    setBusy(true);
    try {
      await api("/api/owner/tenants", { body: { name: name.trim(), username: username.trim(), password, notes: notes.trim() || undefined } });
      setCreated({ username: username.trim(), password });
      onDone();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  if (created) {
    const text = `بيانات دخولك على HSN AutoReply:\nاسم المتجر: ${created.username}\nكلمة المرور: ${created.password}\n${location.origin}`;
    return (
      <Modal open onClose={onClose} title="تم إنشاء العميل ✅">
        <Alert tone="warn">أرسل بيانات الدخول للعميل بنفسك عبر قناة خاصة. كلمة المرور لا تظهر مرة ثانية (تقدر تعيد تعيينها لاحقًا).</Alert>
        <pre className="surface-2 mt-3 whitespace-pre-wrap rounded-2xl p-4 text-sm" dir="auto">{text}</pre>
        <div className="mt-3 flex gap-2">
          <button className="btn btn-primary flex-1" onClick={() => navigator.clipboard?.writeText(text).then(() => toast("تم النسخ"))}><Icon name="copy" size={17} />نسخ البيانات</button>
          <button className="btn btn-ghost" onClick={onClose}>تم</button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal open onClose={onClose} title="عميل جديد">
      <div className="space-y-3">
        <Field label="اسم المتجر (للدخول)" hint="بالإنجليزي بدون مسافات، مثل اسم حسابه في إنستقرام: shop_noor">
          <input className="input" dir="ltr" value={username} onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))} maxLength={64} />
        </Field>
        <Field label="اسم المستخدم (اسم العميل)"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
        <Field label="كلمة المرور المؤقتة" hint="12 حرفًا على الأقل. أنشأنا لك واحدة قوية.">
          <div className="flex gap-2">
            <input className="input" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="btn btn-ghost shrink-0" onClick={() => setPassword(generatePassword())} aria-label="توليد كلمة مرور"><Icon name="refresh" size={17} /></button>
          </div>
        </Field>
        <Field label="ملاحظات (اختياري، تظهر لك فقط)"><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></Field>
        <button className="btn btn-primary w-full" disabled={busy || name.trim().length < 2 || username.trim().length < 3 || password.length < 12} onClick={submit}>
          {busy ? "جارٍ الإنشاء…" : "إنشاء العميل"}
        </button>
      </div>
    </Modal>
  );
}

/** Loose match for search: case, Arabic diacritics and alef / ya / ta-marbuta variants ignored. */

function CustomersTab() {
  const { data, loading, error, reload } = useAsync(() => api<any[]>("/api/owner/tenants"), []);
  const { data: plans } = useAsync(() => api<any[]>("/api/owner/plans"), []);
  const [planFor, setPlanFor] = useState<any>(null);
  const [messageFor, setMessageFor] = useState<any | null>(null);
  const [diagnoseFor, setDiagnoseFor] = useState<any | null>(null);
  const [adding, setAdding] = useState(false);
  // Search by store (login) name, user name, email or Instagram handle; each card's details open on demand.
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  const all = (data ?? []).filter((t) => !t.is_owner);
  const nq = normText(q);
  const customers = nq ? all.filter((t) => [t.name, t.username, t.email, t.ig_username].some((v) => v && normText(String(v)).includes(nq))) : all;
  return (
    <div className="space-y-5">
      {adding && <NewCustomer onClose={() => setAdding(false)} onDone={reload} />}
      {messageFor && <MessageModal tenant={messageFor} onClose={() => setMessageFor(null)} />}
      {diagnoseFor && <DiagnoseModal tenant={diagnoseFor} onClose={() => setDiagnoseFor(null)} />}
      {planFor && <SetPlan t={planFor} plans={plans ?? []} onClose={() => setPlanFor(null)} onDone={() => { setPlanFor(null); reload(); }} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="muted text-sm">{data ? `${all.length} عميل · ${all.filter((t) => t.status === "active" && t.plan_expires_at > Date.now()).length} باشتراك فعّال` : ""}</p>
        <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={18} />عميل جديد</button>
      </div>
      <div className="relative max-w-md">
        <span className="muted pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"><Icon name="search" size={18} /></span>
        <input className="input pr-10" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث باسم المتجر أو اسم المستخدم" aria-label="بحث في العملاء" />
      </div>
      {q && data && <p className="muted text-sm">{customers.length ? `${customers.length} نتيجة` : "ما فيه عميل بهذا الاسم"}</p>}
      {loading && !data ? <Spinner /> : error ? <Alert tone="bad">{error}</Alert> : !all.length ? (
        <Empty title="لا يوجد عملاء بعد">اضغط «عميل جديد» لإنشاء أول حساب.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {customers.map((t) => (
            <Card key={t.id} className={`self-start ${t.status !== "active" ? "opacity-70" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <b className="font-display block truncate text-base">{t.name}</b>
                  <span className="muted block text-xs">اسم المستخدم: <b className="text-[var(--text)]">{t.name}</b></span>
                  <span className="muted block text-xs">اسم المتجر (الدخول): <b className="text-[var(--text)]" dir="ltr">{t.username ?? "—"}</b></span>
                  {!t.is_owner && <span className="muted block text-xs">الإيميل: {t.email ? <><b className="text-[var(--text)]" dir="ltr">{t.email}</b> {t.email_verified_at ? <span className="text-emerald-600">✓ مؤكَّد</span> : <span className="text-amber-600">(غير مؤكَّد)</span>}</> : "—"}</span>}
                  {!t.is_owner && !!t.totp_enabled_at && (
                    <span className="muted flex flex-wrap items-center gap-2 text-xs">
                      🔐 التحقق بخطوتين: <b className="text-emerald-600">مفعّل</b>
                      <button
                        type="button"
                        className="font-semibold text-red-600 underline"
                        onClick={async () => {
                          if (!(await askConfirm({ title: `إيقاف التحقق بخطوتين لـ «${t.name}»؟`, message: "استخدمه بس إذا العميل ضيّع جواله ورموز الاسترداد، وتأكدت إنه صاحب الحساب فعلًا. بعدها يدخل بكلمة المرور وحدها ويقدر يفعّله من جديد.", confirmLabel: "إيقاف", danger: true }))) return;
                          act(() => api(`/api/owner/tenants/${t.id}/totp-reset`, { body: {} }), "تم إيقاف التحقق بخطوتين");
                        }}
                      >
                        إيقاف (فقد جواله)
                      </button>
                    </span>
                  )}
                </div>
                <span className={`chip ${t.status === "active" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"}`}>
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />{t.status === "active" ? "نشط" : "موقوف"}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-xs [&>div]:min-w-0">
                <div><b className="font-display block truncate text-sm" dir="ltr" title={t.ig_username ? `@${t.ig_username}` : undefined} style={{ textAlign: "right" }}>{t.ig_username ? `@${t.ig_username}` : "—"}</b><span className="muted">{t.ig_status === "active" ? "إنستقرام متصل" : t.ig_username ? "غير متصل" : "لم يربط بعد"}</span></div>
                <div><b className="font-display block text-base">{t.active_campaigns}/{t.campaigns}</b><span className="muted">حملات نشطة</span></div>
                <div><b className="font-display block text-base">{t.flows_30d}</b><span className="muted">تفاعل (30 يوم)</span></div>
              </div>
              <SubscriptionBar t={t} onEdit={() => setPlanFor(t)} />
              <button type="button" className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl py-1.5 text-sm font-semibold text-violet-700 hover:bg-violet-500/5 dark:text-violet-300" aria-expanded={open.has(t.id)} onClick={() => toggle(t.id)}>
                التفاصيل <Icon name="chev" size={16} className={`transition ${open.has(t.id) ? "rotate-180" : ""}`} />
              </button>
              {open.has(t.id) && (<>
              {t.notes && <p className="muted mt-2 text-xs">📝 {t.notes}</p>}
              <p className="muted mt-2 text-[11px]">أُنشئ {fmtTime(t.created_at)} · آخر دخول {t.last_seen_at ? fmtTime(t.last_seen_at) : "لم يدخل بعد"}</p>
              {t.ig_username && (
                <div className="mt-2 rounded-2xl border border-amber-300/60 px-3 dark:border-amber-800/60">
                  <Toggle
                    checked={!!t.follow_gate_allowed}
                    onChange={async (v) => {
                      if (v && !(await askConfirm({ title: "السماح بشرط المتابعة الإلزامي؟", message: "معيار Meta للسبام يمنعه، وهو مخصص لحساباتك أنت فقط.", confirmLabel: "أفهم المخاطرة — اسمح", danger: true }))) return;
                      act(() => api(`/api/owner/tenants/${t.id}/follow-gate`, { body: { allowed: v } }), v ? "سُمح بالشرط" : "أُوقف الشرط");
                    }}
                    label="شرط المتابعة الإلزامي"
                    description="لحساباتك فقط — لا تفعّله لحسابات العملاء"
                  />
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button className="btn btn-ghost min-h-9 text-xs" onClick={() => setPlanFor(t)}><Icon name="zap" size={15} />الباقة</button>
                {!t.is_owner && <button className="btn btn-ghost min-h-9 text-xs" onClick={() => setMessageFor(t)}><Icon name="send" size={15} />رسالة</button>}
                {!t.is_owner && <button className="btn btn-ghost min-h-9 text-xs" onClick={() => setDiagnoseFor(t)}>🩺 تشخيص</button>}
                <button
                  className="btn btn-ghost min-h-9 text-xs"
                  onClick={async () => {
                    const pw = generatePassword();
                    if (!(await askConfirm({ title: `كلمة مرور جديدة لـ «${t.name}»؟`, message: "يُسجَّل خروجه من كل الأجهزة، وتعطيه كلمة المرور الجديدة بنفسك.", confirmLabel: "تعيين كلمة مرور جديدة" }))) return;
                    act(() => api(`/api/owner/tenants/${t.id}/password`, { body: { password: pw } }).then(() => showCopy({ title: "كلمة المرور الجديدة", message: "انسخها وأرسلها للعميل. ما راح تظهر مرة ثانية.", text: pw })), "تم تعيين كلمة مرور جديدة");
                  }}
                >
                  <Icon name="lock" size={15} />كلمة مرور جديدة
                </button>
                {t.status === "active" ? (
                  <button className="btn btn-ghost min-h-9 text-xs text-red-600" onClick={async () => (await askConfirm({ title: `إيقاف «${t.name}»؟`, message: "يُسجَّل خروجه وتتوقف ردوده التلقائية. بياناته تبقى، وتقدر تفعّله لاحقًا.", confirmLabel: "إيقاف العميل", danger: true })) && act(() => api(`/api/owner/tenants/${t.id}/status`, { body: { status: "suspended" } }), "تم إيقاف العميل")}>
                    إيقاف
                  </button>
                ) : (
                  <button className="btn btn-ghost min-h-9 text-xs" onClick={() => act(() => api(`/api/owner/tenants/${t.id}/status`, { body: { status: "active" } }), "تم تفعيل العميل")}>
                    تفعيل
                  </button>
                )}
                <button
                  className="btn btn-ghost min-h-9 text-xs text-red-600"
                  onClick={async () => {
                    const typed = await askText({ title: `حذف «${t.name}» نهائيًا؟`, message: "تنحذف كل بياناته: الحملات والرسائل والسحوبات والسجلات. ما يمكن التراجع.", label: "للتأكيد اكتب اسم العميل كما هو", expect: t.name, confirmLabel: "حذف العميل نهائيًا", danger: true });
                    if (typed === null) return;
                    act(() => api(`/api/owner/tenants/${t.id}`, { method: "DELETE", body: { confirm: typed } }), "تم حذف العميل");
                  }}
                >
                  <Icon name="x" size={15} />حذف
                </button>
              </div>
              </>)}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

const DAY = 86_400_000;

/** Days left in the customer's subscription as a bar (green → amber → red), with the plan and monthly usage. */
function SubscriptionBar({ t, onEdit }: { t: any; onEdit: () => void }) {
  const now = Date.now();
  const exp: number | null = t.plan_expires_at ?? null;
  const active = !!exp && exp > now;
  const daysLeft = active ? Math.ceil((exp! - now) / DAY) : 0;
  const start: number = t.plan_started_at && exp && t.plan_started_at < exp ? t.plan_started_at : (exp ?? now) - 30 * DAY;
  const total = Math.max(1, (exp ?? now) - start);
  const pct = active ? Math.max(3, Math.min(100, Math.round(((exp! - now) / total) * 100))) : 0;
  const tone = !active ? "bg-red-500" : daysLeft <= 3 ? "bg-red-500" : daysLeft <= 7 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <button type="button" onClick={onEdit} className="mt-3 block w-full rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-3 text-right transition hover:border-violet-400" title="تعديل الاشتراك">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-display text-sm font-extrabold">{t.plan_name ?? "بدون باقة"}</span>
        <span className={`font-bold ${!active ? "text-red-600" : daysLeft <= 3 ? "text-red-600" : daysLeft <= 7 ? "text-amber-600" : "text-emerald-600"}`}>
          {!exp ? "لا يوجد اشتراك" : active ? `باقي ${daysLeft} ${daysLeft === 1 ? "يوم" : daysLeft <= 10 ? "أيام" : "يوم"}` : "منتهي"}
        </span>
      </div>
      <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-[var(--border)]" role="progressbar" aria-label="المدة المتبقية من الاشتراك" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <div className="muted mt-1.5 text-[11px]">{exp ? `${active ? "ينتهي" : "انتهى"} ${fmtDate(exp)}` : "اضغط لتعيين باقة"}</div>
      <MessagesMeter used={t.messages_month ?? 0} limit={t.plan_id ? (t.messages_limit ?? null) : 0} />
    </button>
  );
}

/** This month's messages against the plan's limit (null = unlimited). */
function MessagesMeter({ used, limit }: { used: number; limit: number | null }) {
  const pct = limit === null ? 0 : limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
  return (
    <div className="mt-2.5">
      <div className="flex justify-between text-[11px]">
        <span className="font-semibold">رسائل الدورة (30 يوم)</span>
        <span className="muted" dir="ltr">{used.toLocaleString("en-US")} / {limit === null ? "∞" : limit.toLocaleString("en-US")}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--border)]" role="progressbar" aria-label="رسائل الشهر" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full ${pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-violet-500"}`} style={{ width: `${limit === null ? 3 : Math.max(2, pct)}%` }} />
      </div>
    </div>
  );
}

function SetPlan({ t, plans, onClose, onDone }: { t: any; plans: any[]; onClose: () => void; onDone: () => void }) {
  const now = Date.now();
  const active = !!t.plan_expires_at && t.plan_expires_at > now;
  const [planId, setPlanId] = useState<string>(t.plan_id ?? plans[0]?.id ?? "");
  const [days, setDays] = useState(30);
  const [date, setDate] = useState(() => new Date(active ? t.plan_expires_at : now + 30 * DAY).toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const save = async (body: Record<string, unknown>, msg: string) => {
    setBusy(true);
    try {
      await api(`/api/owner/tenants/${t.id}/plan`, { body });
      toast(msg);
      onDone();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const preview = (d: number) => fmtDate((active ? t.plan_expires_at : now) + d * DAY);
  return (
    <Modal open onClose={onClose} title={`اشتراك «${t.name}»`}>
      <div className="space-y-4">
        <div className="rounded-2xl bg-[var(--surface-2)] p-3 text-sm">
          {t.plan_expires_at ? (
            <>الباقة الحالية: <b>{t.plan_name ?? "—"}</b> · {active ? `ينتهي ${fmtDate(t.plan_expires_at)} (باقي ${Math.ceil((t.plan_expires_at - now) / DAY)} يوم)` : "منتهي"}</>
          ) : (
            "لا يوجد اشتراك بعد"
          )}
        </div>
        <Field label="الباقة">
          <select className="input" value={planId} onChange={(e) => setPlanId(e.target.value)}>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        {t.plan_expires_at && planId !== t.plan_id && (
          <button className="btn btn-ghost w-full" disabled={busy || !planId} onClick={() => save({ plan_id: planId }, "تم تغيير الباقة")}>تغيير الباقة فقط (نفس تاريخ الانتهاء)</button>
        )}
        <Field label={active ? "إضافة أيام (بعد تاريخ الانتهاء الحالي)" : "مدة الاشتراك (تبدأ من اليوم)"}>
          <div className="flex flex-wrap gap-2">
            {[7, 30, 90, 180, 365].map((d) => (
              <button key={d} type="button" className={`rounded-xl border px-3 py-2 text-sm font-bold ${days === d ? "border-violet-500 bg-violet-500/10" : "border-[var(--border)]"}`} onClick={() => setDays(d)}>+{d}</button>
            ))}
            <input className="input !w-24" type="number" min={1} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="عدد الأيام" />
          </div>
        </Field>
        <button className="btn btn-primary w-full" disabled={busy || !planId || days < 1} onClick={() => save({ plan_id: planId, days }, `تمت إضافة ${days} يوم`)}>
          {active ? `إضافة ${days} يوم — ينتهي ${preview(days)}` : `تفعيل ${days} يوم — ينتهي ${preview(days)}`}
        </button>
        {active && (
          <div className="flex flex-wrap gap-2">
            {[1, 7, 30].map((d) => (
              <button key={d} className="btn btn-ghost min-h-9 flex-1 text-xs" disabled={busy} onClick={async () => (await askConfirm({ title: `خصم ${d} يوم من اشتراك «${t.name}»؟`, confirmLabel: `خصم ${d} يوم` })) && save({ plan_id: t.plan_id ?? planId, days: -d }, `تم خصم ${d} يوم`)}>−{d} يوم</button>
            ))}
          </div>
        )}
        <Field label="أو حدّد تاريخ انتهاء بالضبط">
          <div className="flex flex-wrap items-center gap-2">
            <DateTimeField dateOnly clearable={false} label="تاريخ انتهاء الاشتراك" value={date} onChange={setDate} />
            <button className="btn btn-ghost shrink-0" disabled={busy || !planId || !date} onClick={() => save({ plan_id: planId, expires_at: new Date(`${date}T23:59:59`).getTime() }, "تم تحديد تاريخ الانتهاء")}>حفظ التاريخ</button>
          </div>
        </Field>
        {active && <button className="btn btn-ghost w-full text-red-600" disabled={busy} onClick={async () => (await askConfirm({ title: "إنهاء اشتراك العميل الآن؟", message: "تتوقف ردوده التلقائية فورًا.", confirmLabel: "إنهاء الاشتراك", danger: true })) && save({ plan_id: t.plan_id, expires_at: Date.now() }, "تم إنهاء الاشتراك")}>إنهاء الاشتراك الآن</button>}
      </div>
    </Modal>
  );
}

function CodesTab() {
  const { data, reload } = useAsync(() => api<any[]>("/api/owner/codes"), []);
  const { data: plans } = useAsync(() => api<any[]>("/api/owner/plans"), []);
  const [planId, setPlanId] = useState("pro");
  const [days, setDays] = useState(30);
  const [count, setCount] = useState(1);
  const [note, setNote] = useState("");
  const [fresh, setFresh] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ codes: string[] }>("/api/owner/codes", { body: { plan_id: planId, days, count, note: note.trim() || undefined } });
      setFresh(r.codes);
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const planName = (id: string) => plans?.find((p) => p.id === id)?.name ?? id;
  return (
    <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
      <Card title="توليد أكواد">
        <div className="space-y-3">
          <Field label="الباقة">
            <select className="input" value={planId} onChange={(e) => setPlanId(e.target.value)}>
              {(plans ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="المدة (أيام)"><input className="input" type="number" min={1} value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field>
            <Field label="العدد"><input className="input" type="number" min={1} max={50} value={count} onChange={(e) => setCount(Number(e.target.value))} /></Field>
          </div>
          <Field label="ملاحظة (اختياري)" hint="مثلًا اسم المشتري أو رقم الطلب"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></Field>
          <button className="btn btn-primary w-full" disabled={busy || days < 1 || count < 1} onClick={create}>{busy ? "…" : `توليد ${count} كود`}</button>
        </div>
        {fresh && (
          <div className="mt-4 space-y-2">
            <Alert tone="warn">انسخ الأكواد الآن — تظهر مرة واحدة فقط (نحفظ بصمتها فقط، لا الكود نفسه).</Alert>
            <pre className="surface-2 whitespace-pre-wrap rounded-2xl p-3 text-sm" dir="ltr">{fresh.join("\n")}</pre>
            <button className="btn btn-ghost w-full" onClick={() => navigator.clipboard?.writeText(fresh.join("\n")).then(() => toast("تم النسخ"))}><Icon name="copy" size={17} />نسخ</button>
          </div>
        )}
      </Card>
      <Card title="الأكواد" action={data && <span className="muted text-xs">{data.length} كود · {data.filter((c) => c.used_at).length} مستخدم</span>}>
        {!data ? <Spinner /> : !data.length ? <Empty title="لا توجد أكواد بعد" /> : (
          <ul className="space-y-2">
            {data.map((c) => {
              const state = c.used_at ? "used" : c.revoked_at ? "revoked" : "open";
              return (
                <li key={c.id} className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono rounded-lg bg-[var(--surface)] px-2 py-0.5 text-xs font-bold ring-1 ring-[var(--border)]" dir="ltr">HSN-••••-••••-{c.hint}</span>
                    <span className="chip bg-violet-500/10 text-violet-700 dark:text-violet-200">{c.plan_name ?? planName(c.plan_id)} · {c.days} يوم</span>
                    <span className={`chip ${state === "used" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : state === "revoked" ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300" : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"}`}>
                      {state === "used" ? "مستخدم" : state === "revoked" ? "ملغى" : "غير مستخدم"}
                    </span>
                    <span className="mr-auto flex gap-1">
                      {state === "open" && (
                        <button className="btn btn-ghost min-h-8 px-2 text-xs" onClick={async () => (await askConfirm({ title: "إلغاء هذا الكود؟", message: "ما يقدر أحد يستخدمه بعد الإلغاء.", confirmLabel: "إلغاء الكود", danger: true })) && api(`/api/owner/codes/${c.id}/revoke`, { body: {} }).then(() => { toast("أُلغي"); reload(); }, (e) => toast(e.message, "bad"))}>إلغاء</button>
                      )}
                      <button className="btn btn-ghost min-h-8 px-2 text-xs text-red-600" aria-label="حذف الكود" onClick={async () => (await askConfirm({ title: state === "used" ? "حذف الكود من القائمة؟" : "حذف الكود نهائيًا؟", message: state === "used" ? "اشتراك العميل يبقى كما هو." : undefined, confirmLabel: "حذف الكود", danger: true })) && api(`/api/owner/codes/${c.id}`, { method: "DELETE" }).then(() => { toast("حُذف"); reload(); }, (e) => toast(e.message, "bad"))}>
                        <Icon name="x" size={14} />حذف
                      </button>
                    </span>
                  </div>
                  <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                    <div className="flex gap-1.5"><dt className="muted">أُنشئ:</dt><dd>{fmtTime(c.created_at)}</dd></div>
                    {c.note && <div className="flex gap-1.5"><dt className="muted">ملاحظة:</dt><dd>{c.note}</dd></div>}
                    {state === "used" && (
                      <>
                        <div className="flex flex-wrap gap-x-1.5"><dt className="muted">استخدمه:</dt><dd>
                          {c.used_by_username || c.used_by ? (
                            <>
                              {c.used_by_username && <b dir="ltr">@{c.used_by_username}</b>}
                              {c.used_by && <span className={c.used_by_username ? "muted" : "font-bold"}>{c.used_by_username ? ` — ${c.used_by}` : c.used_by}</span>}
                              {!c.customer_exists && <span className="text-red-600"> (العميل محذوف)</span>}
                            </>
                          ) : (
                            <span className="muted">عميل محذوف قبل ما يبدأ النظام يحفظ الأسماء</span>
                          )}
                        </dd></div>
                        <div className="flex gap-1.5"><dt className="muted">وقت التفعيل:</dt><dd>{fmtTime(c.used_at)}</dd></div>
                        {c.customer_exists && c.customer_expires_at ? <div className="flex gap-1.5"><dt className="muted">اشتراكه الحالي حتى:</dt><dd>{fmtDate(c.customer_expires_at)}</dd></div> : null}
                      </>
                    )}
                    {state === "revoked" && <div className="flex gap-1.5"><dt className="muted">أُلغي:</dt><dd>{fmtTime(c.revoked_at)}</dd></div>}
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
        <p className="muted mt-3 text-[11px]">الكود الكامل يظهر مرة واحدة عند التوليد فقط — نحفظ بصمته للأمان، ونعرض آخر 4 أحرف للتعرّف عليه.</p>
      </Card>
    </div>
  );
}

const LIMIT_FIELDS: Array<[string, string]> = [
  ["active_campaigns", "الحملات النشطة"],
  ["monthly_messages", "الرسائل شهريًا"],
  ["draws_per_month", "السحوبات شهريًا"],
  ["staff", "عدد الموظفين (0 = بدون، فارغ = حتى 10)"],
];

function PlansTab() {
  const { data, reload } = useAsync(() => api<any[]>("/api/owner/plans"), []);
  const { data: catalog, reload: reloadCatalog } = useAsync(() => api<any>("/api/public/plans"), []);
  const { data: settings, reload: reloadSettings } = useAsync(() => api<{ sales_contact: string; app_download_url: string; card_button_label: string; exchange_rates: Record<string, number> }>("/api/owner/settings"), []);
  const [contact, setContact] = useState<string | null>(null);
  const [download, setDownload] = useState<string | null>(null);
  const [cardLabel, setCardLabel] = useState<string | null>(null);
  if (!data || !settings) return <Spinner />;
  const saveSetting = async (body: Record<string, string>) => {
    try {
      await api("/api/owner/settings", { method: "PUT", body });
      toast("تم الحفظ");
      reloadSettings();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  return (
    <div className="space-y-5">
      <Card title="صفحة الباقات العامة">
        <p className="muted mb-3 text-sm">
          صفحة يشوفها أي شخص فيها باقاتك وأسعارك:{" "}
          <a className="font-semibold text-violet-600 underline dark:text-violet-300" href="/pricing" target="_blank" rel="noopener">{location.origin}/pricing</a>
        </p>
        <Field label="رابط التواصل للشراء" hint="يظهر كزر «تواصل معنا» — مثل رابط واتساب https://wa.me/966… أو رابط حسابك في إنستقرام">
          <div className="flex gap-2">
            <input className="input" dir="ltr" value={contact ?? settings.sales_contact} onChange={(e) => setContact(e.target.value)} placeholder="https://wa.me/966..." />
            <button className="btn btn-primary shrink-0" onClick={() => saveSetting({ sales_contact: (contact ?? settings.sales_contact).trim() })}>حفظ</button>
          </div>
        </Field>
        <div className="mt-4">
          <Field label="رابط تنزيل التطبيق للعملاء" hint={`اتركه فارغًا لاستخدام الرابط الثابت ${location.origin}/app.apk — يتحدّث تلقائيًا مع كل إصدار جديد`}>
            <div className="flex gap-2">
              <input className="input" dir="ltr" value={download ?? settings.app_download_url} onChange={(e) => setDownload(e.target.value)} placeholder={`${location.origin}/app.apk`} />
              <button className="btn btn-primary shrink-0" onClick={() => saveSetting({ app_download_url: (download ?? settings.app_download_url).trim() })}>حفظ</button>
            </div>
          </Field>
        </div>
        <div className="mt-4">
          <Field label="نص زر الدفع بالبطاقة" hint="يظهر على زر كل باقة (بدون السعر والعملة). فارغ = «اشترك الآن»">
            <div className="flex gap-2">
              <input className="input" value={cardLabel ?? settings.card_button_label} onChange={(e) => setCardLabel(e.target.value)} maxLength={40} placeholder="اشترك الآن" />
              <button className="btn btn-primary shrink-0" onClick={() => saveSetting({ card_button_label: (cardLabel ?? settings.card_button_label).trim() })}>حفظ</button>
            </div>
          </Field>
        </div>
      </Card>
      <RatesCard rates={settings.exchange_rates} onSaved={reloadSettings} />
      <FeaturedCard plans={data} />
      {catalog && <FeatureOrderCard saved={orderFeatures(catalog.feature_order)} onSaved={reloadCatalog} />}
      <div className="grid gap-5 xl:grid-cols-3">
        {data.map((p) => <PlanEditor key={p.id} plan={p} order={catalog?.feature_order} onSaved={reload} />)}
      </div>
    </div>
  );
}

function PlanEditor({ plan, order, onSaved }: { plan: any; order?: string[]; onSaved: () => void }) {
  const [f, setF] = useState(() => ({ ...plan, price_before: plan.price_before ?? "", card_price: plan.card_price_halalas == null ? "" : plan.card_price_halalas / 100, limits: { ...plan.limits } }));
  const [busy, setBusy] = useState(false);
  const setL = (k: string, v: unknown) => setF((x: any) => ({ ...x, limits: { ...x.limits, [k]: v } }));
  const save = async () => {
    setBusy(true);
    try {
      const amount = f.price_amount === "" || f.price_amount === null || f.price_amount === undefined ? null : Number(f.price_amount);
      const cardSar = f.card_price === "" || f.card_price == null ? null : Number(f.card_price);
      const before = f.price_before === "" || f.price_before == null ? null : Number(f.price_before);
      await api(`/api/owner/plans/${plan.id}`, {
        method: "PUT",
        body: { name: f.name, price_amount: amount, price_before: before, price_currency: f.price_currency || "SAR", price_period: f.price_period || "month", card_price_sar: cardSar, description: f.description || undefined, active: !!f.active, limits: f.limits },
      });
      toast(`تم حفظ باقة «${f.name}»`);
      onSaved();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={f.name || plan.id} action={<span className="chip surface-2 muted" dir="ltr">{plan.id}</span>}>
      <div className="space-y-3">
        <Field label="الاسم"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={40} /></Field>
        <Field label="السعر" hint={f.price_amount === "" || f.price_amount == null ? "فارغ = يظهر «تواصل معنا»" : `يظهر للعملاء: ${formatPrice(Number(f.price_amount), f.price_currency || "SAR", f.price_period || "month")}`}>
          <div className="grid grid-cols-2 gap-2">
            <input className="input col-span-2 text-lg font-bold" type="number" min={0} step="any" dir="ltr" value={f.price_amount ?? ""} onChange={(e) => setF({ ...f, price_amount: e.target.value })} placeholder="المبلغ، مثل 99" aria-label="المبلغ" />
            <select className="input min-w-0 text-sm" value={f.price_currency || "SAR"} onChange={(e) => setF({ ...f, price_currency: e.target.value })} aria-label="العملة">
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
            <select className="input min-w-0 text-sm" value={f.price_period || "month"} onChange={(e) => setF({ ...f, price_period: e.target.value })} aria-label="المدة">
              {Object.entries(PRICE_PERIODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
        </Field>
        <Field label={<Tip text="السعر القديم بنفس العملة، يظهر مشطوبًا بجانب السعر مع نسبة الخصم. لازم يكون أعلى من السعر الحالي.">السعر قبل الخصم</Tip>} hint={f.price_before === "" || f.price_before == null ? "فارغ = بدون سعر مشطوب" : f.price_amount !== "" && f.price_amount != null && Number(f.price_before) > Number(f.price_amount) ? `يظهر مشطوبًا: ${Number(f.price_before).toLocaleString("en-US")} — خصم ${Math.round((1 - Number(f.price_amount) / Number(f.price_before)) * 100)}%` : "لازم يكون أعلى من السعر عشان يظهر"}>
          <input className="input" type="number" min={0} step="any" dir="ltr" value={f.price_before ?? ""} onChange={(e) => setF({ ...f, price_before: e.target.value })} />
        </Field>
        <Field label={<Tip text="سعر ثابت بالريال السعودي يدفعه العميل ببطاقة (مدى / فيزا / ماستركارد / Apple Pay) عن طريق ميسّر، وتتفعّل الباقة تلقائيًا بعد الدفع لمدة الباقة (شهر 30 يوم، 3 أشهر 90، سنة 365). فارغ = نفس سعر الباقة إذا كان بالريال السعودي. 0 = بدون دفع بالبطاقة لهذي الباقة.">💳 سعر الدفع بالبطاقة (ر.س)</Tip>} hint={f.price_period === "once" ? "الدفع بالبطاقة يحتاج مدة (شهر / 3 أشهر / سنة) — مو «مرة واحدة»" : f.card_price === "" || f.card_price == null ? ((f.price_currency || "SAR") === "SAR" && f.price_amount ? `فارغ = نفس سعر الباقة (${Number(f.price_amount).toLocaleString("en-US")} ر.س)` : "فارغ والسعر مو بالريال = بدون دفع بالبطاقة") : Number(f.card_price) === 0 ? "بدون دفع بالبطاقة" : `العميل يدفع ${Number(f.card_price).toLocaleString("en-US")} ر.س`}>
          <input className="input" type="number" min={0} step="any" dir="ltr" value={f.card_price ?? ""} onChange={(e) => setF({ ...f, card_price: e.target.value })} placeholder="مثل 99" />
        </Field>
        <Field label="وصف قصير"><input className="input" value={f.description ?? ""} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={200} /></Field>
        {LIMIT_FIELDS.map(([k, label]) => (
          <Field key={k} label={<Tip text={LIMIT_HINTS[k]}>{label}</Tip>} hint="فارغ = غير محدود">
            <input className="input" type="number" min={0} value={f.limits[k] ?? ""} onChange={(e) => setL(k, e.target.value === "" ? null : Number(e.target.value))} />
          </Field>
        ))}
        <div>
          <div className="font-display mb-1.5 text-[13px] font-bold text-[var(--text-2)]"><Tip text={LIMIT_HINTS.events}>الأحداث</Tip></div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(EVENT_LABELS).map(([k, label]) => {
              const on = f.limits.events.includes(k);
              return (
                <button key={k} type="button" className={`rounded-xl border px-3 py-1.5 text-sm font-bold ${on ? "border-violet-500 bg-violet-500/10" : "border-[var(--border)] muted"}`} onClick={() => setL("events", on ? f.limits.events.filter((x: string) => x !== k) : [...f.limits.events, k])}>
                  {label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="divide-y divide-[var(--border)]">
          {orderFeatures(order).filter((k) => k in FEATURE_LABELS).map((k) => [k, FEATURE_LABELS[k]] as const).map(([k, label]) => <Toggle key={k} checked={!!f.limits[k]} onChange={(v) => setL(k, v)} label={<Tip text={FEATURE_HINTS[k]}>{label}</Tip>} />)}
          <Toggle checked={!!f.active} onChange={(v) => setF({ ...f, active: v })} label="معروضة للعملاء" description="تظهر في صفحة الأسعار وصفحة «اشتراكي». إخفاؤها لا يوقف المشتركين الحاليين فيها، وتقدر تولّد لها أكواد." />
        </div>
        <button className="btn btn-primary w-full" disabled={busy} onClick={save}>{busy ? "…" : "حفظ الباقة"}</button>
      </div>
    </Card>
  );
}

export function OwnerPage() {
  const [tab, setTab] = useState<"customers" | "health" | "support" | "plans" | "codes" | "coupons" | "payments" | "branding">(() => (new URLSearchParams(location.hash.split("?")[1] ?? "").get("tab") as any) || (location.hash.startsWith("#/support") ? "support" : "customers"));
  // A link to a tab (e.g. a support notification → #/owner?tab=support) while the page is already open.
  useEffect(() => {
    const on = () => {
      const t = new URLSearchParams(location.hash.split("?")[1] ?? "").get("tab");
      if (t) setTab(t as any);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  // A staff login opens on the first tab it may use.
  useEffect(() => {
    if (!hasPerm(TAB_PERM[tab])) {
      const first = TABS.find(([k]) => hasPerm(TAB_PERM[k]));
      if (first) setTab(first[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-extrabold leading-tight sm:text-[26px]">العملاء والاشتراكات</h1>
        <p className="muted mt-1 text-sm">العملاء، الباقات، وأكواد التفعيل — لإدارة الخدمة فقط.</p>
      </header>
      <div className="seg w-fit max-w-full overflow-x-auto" role="tablist">
        {TABS.filter(([k]) => hasPerm(TAB_PERM[k])).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === "customers" ? <><BroadcastCard /><SentMessages /><CustomersTab /></> : tab === "health" ? <HealthTab /> : tab === "support" ? <OwnerSupportTab /> : tab === "coupons" ? <CouponsTab /> : tab === "plans" ? <PlansTab /> : tab === "codes" ? <CodesTab /> : tab === "payments" ? <CardPaymentsCard /> : <BrandingTab />}
    </div>
  );
}

function RatesCard({ rates, onSaved }: { rates: Record<string, number>; onSaved: () => void }) {
  const [r, setR] = useState(() => ({ SAR: String(rates.SAR ?? ""), YER: String(rates.YER ?? ""), YER_SAN: String(rates.YER_SAN ?? "") }));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api("/api/owner/settings", { method: "PUT", body: { exchange_rates: { SAR: Number(r.SAR), YER: Number(r.YER), YER_SAN: Number(r.YER_SAN) } } });
      toast("تم حفظ أسعار الصرف");
      onSaved();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const ok = [r.SAR, r.YER, r.YER_SAN].every((v) => Number(v) > 0);
  return (
    <Card title="أسعار الصرف">
      <p className="muted mb-3 text-sm">يشوف العميل سعر كل باقة بالعملة اللي يختارها، محسوبًا بأسعارك هذه. السعر الأساسي يبقى بالعملة اللي حددتها في الباقة.</p>
      <div className="grid gap-3 sm:grid-cols-4 sm:items-end">
        {([["SAR", "ريال سعودي"], ["YER", "ريال يمني"], ["YER_SAN", "ريال يمني / صنعاء"]] as const).map(([k, l]) => (
          <Field key={k} label={`1 دولار = ? ${l}`}>
            <input className="input" type="number" min={0} step="any" dir="ltr" value={r[k]} onChange={(e) => setR({ ...r, [k]: e.target.value })} />
          </Field>
        ))}
        <button className="btn btn-primary" disabled={busy || !ok} onClick={save}>{busy ? "…" : "حفظ الأسعار"}</button>
      </div>
    </Card>
  );
}

/** Resizes an image file to a small square logo (data URL) so it stays light in the database. */
async function logoDataUrl(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("اختر صورة PNG أو JPG أو WEBP");
  if (file.size > 8 * 1024 * 1024) throw new Error("الصورة كبيرة جدًا (أكثر من 8 ميقا)");
  // Read as a data: URL — the app's security policy allows data: images but not blob: URLs.
  const src = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error("تعذّر قراءة الملف"));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("تعذّر قراءة الصورة — جرّب صورة ثانية"));
    i.src = src;
  });
  const size = 160;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const scale = Math.min(size / img.width, size / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  const webp = canvas.toDataURL("image/webp", 0.88);
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
}

function LogoPicker({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return (
    <div className="flex items-center gap-3">
      {value ? <img src={value} alt="" className="h-14 w-14 rounded-xl bg-white object-contain p-1 ring-1 ring-[var(--border)]" /> : <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-[var(--surface-2)] text-[var(--text-2)] ring-1 ring-[var(--border)]"><Icon name="bank" size={24} /></span>}
      <label className="btn btn-ghost min-h-9 cursor-pointer text-xs">
        <Icon name="upload" size={15} />{value ? "تغيير الشعار" : "رفع شعار"}
        <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) onChange(await logoDataUrl(f).catch((err) => { toast(err.message, "bad"); return value; })); e.target.value = ""; }} />
      </label>
      {value && <button type="button" className="btn btn-ghost min-h-9 text-xs text-red-600" onClick={() => onChange(null)}>إزالة</button>}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { bank: "بنك", exchange: "صرافة", wallet: "محفظة" };
const CUR_NAME = (code: string | null) => (code ? CURRENCIES.find((c) => c.code === code)?.name ?? code : "—");

function AccountForm({ initial, onSubmit, onCancel }: { initial?: any; onSubmit: (v: any) => Promise<void>; onCancel?: () => void }) {
  const [f, setF] = useState({ holder: initial?.holder ?? "", number: initial?.number ?? "", currency: initial?.currency ?? "", note: initial?.note ?? "" });
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSubmit({ holder: f.holder.trim(), number: f.number.trim(), currency: f.currency || null, note: f.note.trim() || undefined });
          if (!initial) setF({ holder: "", number: "", currency: "", note: "" });
        } finally {
          setBusy(false);
        }
      }}
    >
      <input className="input" placeholder="اسم الحساب" value={f.holder} onChange={(e) => setF({ ...f, holder: e.target.value })} maxLength={120} required />
      <input className="input" placeholder="رقم الحساب / الآيبان" dir="ltr" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} maxLength={80} required />
      <select className="input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} aria-label="العملة">
        <option value="">العملة (اختياري)</option>
        {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
      </select>
      <input className="input sm:col-span-2" placeholder="ملاحظة (اختياري) — مثل: الفرع، اسم المستفيد بالإنجليزي" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={200} />
      <div className="flex gap-2">
        <button className="btn btn-primary flex-1" disabled={busy}>{busy ? "…" : initial ? "حفظ" : "إضافة الحساب"}</button>
        {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>إلغاء</button>}
      </div>
    </form>
  );
}

function ProviderCard({ p, first, last, reload }: { p: any; first: boolean; last: boolean; reload: () => void }) {
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState(p.name);
  const [kind, setKind] = useState(p.kind);
  const [logo, setLogo] = useState<string | null>(p.logo);
  const [editing, setEditing] = useState<number | null>(null);
  const [adding, setAdding] = useState(!p.accounts.length);
  const call = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
      throw e;
    }
  };
  return (
    <Card
      title={
        <span className="flex items-center gap-2.5">
          {p.logo ? <img src={p.logo} alt="" className="h-8 w-8 rounded-lg bg-white object-contain p-0.5 ring-1 ring-[var(--border)]" /> : <Icon name="bank" size={20} />}
          {p.name}
          <span className="chip surface-2 muted text-[11px]">{KIND_LABEL[p.kind] ?? "بنك"}</span>
        </span>
      }
      action={
        <span className="flex gap-1">
          <button className="btn btn-ghost min-h-8 px-2 text-xs" disabled={first} aria-label="تحريك لأعلى" onClick={() => call(() => api(`/api/owner/payment-providers/${p.id}/move`, { body: { dir: "up" } }), "تم")}>↑</button>
          <button className="btn btn-ghost min-h-8 px-2 text-xs" disabled={last} aria-label="تحريك لأسفل" onClick={() => call(() => api(`/api/owner/payment-providers/${p.id}/move`, { body: { dir: "down" } }), "تم")}>↓</button>
          <button className="btn btn-ghost min-h-8 px-2 text-xs" onClick={() => setEdit(!edit)}>تعديل</button>
          <button className="btn btn-ghost min-h-8 px-2 text-xs text-red-600" onClick={async () => (await askConfirm({ title: `حذف «${p.name}»؟`, message: "تنحذف الجهة مع كل حساباتها من صفحة الباقات.", confirmLabel: "حذف", danger: true })) && call(() => api(`/api/owner/payment-providers/${p.id}`, { method: "DELETE" }), "تم الحذف")}>حذف</button>
        </span>
      }
    >
      {edit && (
        <div className="mb-4 space-y-3 rounded-2xl bg-[var(--surface-2)] p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="الاسم" />
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="النوع"><option value="bank">بنك</option><option value="exchange">صرافة</option><option value="wallet">محفظة</option></select>
          </div>
          <LogoPicker value={logo} onChange={setLogo} />
          <button className="btn btn-primary w-full" onClick={() => call(() => api(`/api/owner/payment-providers/${p.id}`, { method: "PUT", body: { name: name.trim(), kind, logo } }), "تم الحفظ").then(() => setEdit(false), () => undefined)}>حفظ</button>
        </div>
      )}
      <ul className="space-y-2">
        {p.accounts.map((a: any) =>
          editing === a.id ? (
            <li key={a.id} className="rounded-2xl border border-violet-400 p-3">
              <AccountForm initial={a} onCancel={() => setEditing(null)} onSubmit={(v) => call(() => api(`/api/owner/payment-accounts/${a.id}`, { method: "PUT", body: v }), "تم الحفظ").then(() => setEditing(null))} />
            </li>
          ) : (
            <li key={a.id} className="flex items-center gap-3 rounded-2xl border border-[var(--border)] px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-xs"><span className="chip bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">{CUR_NAME(a.currency)}</span><span className="muted">{a.holder}</span></div>
                <div className="font-mono font-bold" dir="ltr" style={{ textAlign: "right" }}>{a.number}</div>
                {a.note && <div className="muted text-[11px]">{a.note}</div>}
              </div>
              <button className="btn btn-ghost min-h-8 px-2 text-xs" onClick={() => setEditing(a.id)}>تعديل</button>
              <button className="btn btn-ghost min-h-8 px-2 text-xs text-red-600" onClick={async () => (await askConfirm({ title: "حذف هذا الحساب البنكي؟", confirmLabel: "حذف", danger: true })) && call(() => api(`/api/owner/payment-accounts/${a.id}`, { method: "DELETE" }), "تم الحذف")}>حذف</button>
            </li>
          ),
        )}
      </ul>
      {adding ? (
        <div className="mt-3 rounded-2xl border border-dashed border-[var(--border)] p-3">
          <AccountForm onSubmit={(v) => call(() => api(`/api/owner/payment-providers/${p.id}/accounts`, { body: v }), "تمت إضافة الحساب")} onCancel={p.accounts.length ? () => setAdding(false) : undefined} />
        </div>
      ) : (
        <button className="btn btn-ghost mt-3 w-full text-xs" onClick={() => setAdding(true)}><Icon name="plus" size={15} />إضافة حساب آخر</button>
      )}
    </Card>
  );
}

const CARD_STATUS: Record<string, [string, string]> = {
  paid: ["مدفوع ✅", "text-emerald-700 dark:text-emerald-300"],
  initiated: ["بانتظار الدفع", "muted"],
  failed: ["فشل", "text-red-600"],
  expired: ["لم يكتمل (انتهت المهلة)", "muted"],
  canceled: ["ألغاه العميل", "muted"],
  error: ["خطأ في البوابة", "text-red-600"],
  mismatch: ["مبلغ غير مطابق ⚠️", "text-red-600"],
  refunded: ["مسترجع", "text-amber-600"],
};

/** Card payments through Moyasar: on/off state, the paid total and the latest attempts. */
function CardPaymentsCard() {
  const { data } = useAsync(() => api<any>("/api/owner/card-payments"), []);
  if (!data) return null;
  return (
    <Card title="💳 الدفع بالبطاقة (ميسّر)" className="mb-5">
      {!data.enabled ? (
        <Alert tone="info">غير مفعّل. أضف المفتاح السري من لوحة ميسّر كـ GitHub Secret باسم <b dir="ltr">MOYASAR_SECRET_KEY</b> ثم انشر، وبعدها حط «سعر الدفع بالبطاقة» لكل باقة في تبويب الباقات.</Alert>
      ) : (
        <div className="space-y-3">
          {data.test_mode && <Alert tone="warn">وضع تجريبي (sk_test) — المدفوعات وهمية وما توصل فلوس حقيقية. بدّله بالمفتاح الحي (sk_live) بعد ما يتفعّل حسابك في ميسّر.</Alert>}
          <div className="flex flex-wrap gap-4 text-sm">
            <span>المدفوع: <b>{data.paid_count}</b> دفعة</span>
            <span>الإجمالي: <b>{Number(data.paid_total).toLocaleString("en-US")} ر.س</b> <span className="muted">(قبل عمولة ميسّر)</span></span>
          </div>
          {data.payments.length === 0 ? (
            <p className="muted text-sm">ما فيه دفعات بعد.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="muted text-right text-xs"><th className="p-2">#</th><th className="p-2">العميل</th><th className="p-2">الباقة</th><th className="p-2">المبلغ</th><th className="p-2">الحالة</th><th className="p-2">التاريخ</th></tr></thead>
                <tbody>
                  {data.payments.map((p: any) => ({ ...p, status: p.status === "initiated" && Date.now() - p.created_at > 2 * 3_600_000 ? "expired" : p.status })).map((p: any) => (
                    <tr key={p.id} className="border-t border-[var(--border)]">
                      <td className="p-2" dir="ltr">{p.id}</td>
                      <td className="p-2">{p.tenant_name ?? `#${p.tenant_id}`}</td>
                      <td className="p-2">{p.plan_name ?? p.plan_id} · {p.days} يوم</td>
                      <td className="p-2 font-bold" dir="ltr">{(p.amount / 100).toLocaleString("en-US")} SAR</td>
                      <td className={`p-2 ${CARD_STATUS[p.status]?.[1] ?? ""}`}>{CARD_STATUS[p.status]?.[0] ?? p.status}</td>
                      <td className="muted p-2">{fmtTime(p.paid_at ?? p.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** Reads an image as a data: URL (allowed by the app's CSP) and shrinks it to fit maxW×maxH. */
async function shrinkImage(file: File, maxW: number, maxH: number, quality: number): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("اختر صورة PNG أو JPG أو WEBP");
  if (file.size > 15 * 1024 * 1024) throw new Error("الصورة كبيرة جدًا (أكثر من 15 ميقا)");
  const src = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error("تعذّر قراءة الملف"));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("تعذّر قراءة الصورة — جرّب صورة ثانية"));
    i.src = src;
  });
  const scale = Math.min(1, maxW / img.width, maxH / img.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  let q = quality;
  let out = canvas.toDataURL("image/webp", q);
  if (!out.startsWith("data:image/webp")) out = canvas.toDataURL("image/jpeg", q);
  while (out.length > 1_300_000 && q > 0.4) {
    q -= 0.1;
    out = canvas.toDataURL(out.startsWith("data:image/webp") ? "image/webp" : "image/jpeg", q);
  }
  return out;
}


function FeaturedCard({ plans }: { plans: any[] }) {
  const { data, reload } = useAsync(() => api<any>("/api/public/plans"), []);
  const [planId, setPlanId] = useState<string | null | undefined>(undefined);
  const [label, setLabel] = useState<string | null>(null);
  if (!data) return null;
  const cur = planId === undefined ? data.featured?.plan_id ?? null : planId;
  const text = label ?? data.featured?.label ?? "الأكثر طلبًا";
  const save = async () => {
    try {
      await api("/api/owner/featured-plan", { method: "PUT", body: { plan_id: cur, label: text.trim() } });
      toast("تم الحفظ");
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  return (
    <Card title="شارة الباقة المميزة">
      <p className="muted mb-3 text-sm">تظهر فوق الباقة اللي تختارها في صفحة الباقات (مثل «الأكثر طلبًا»).</p>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="الباقة">
          <select className="input" value={cur ?? ""} onChange={(e) => setPlanId(e.target.value || null)}>
            <option value="">بدون شارة</option>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="نص الشارة"><input className="input" value={text} onChange={(e) => setLabel(e.target.value)} maxLength={30} disabled={!cur} /></Field>
        <button className="btn btn-primary" disabled={!!cur && !text.trim()} onClick={save}>حفظ</button>
      </div>
    </Card>
  );
}

/** Drag (mouse or finger) or use the arrows to set the order the plan points are listed in, everywhere. */
function FeatureOrderCard({ saved, onSaved }: { saved: string[]; onSaved: () => void }) {
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const cur = order ?? saved;
  const dirty = cur.join() !== saved.join();
  const label = (k: string) => LIMIT_ROW_LABELS[k] ?? FEATURE_LABELS[k] ?? k;
  const move = (k: string, to: number) => {
    const next = cur.filter((x) => x !== k);
    next.splice(Math.max(0, Math.min(next.length, to)), 0, k);
    setOrder(next);
  };
  const onDown = (k: string) => (e: ReactPointerEvent) => {
    e.preventDefault();
    setDragging(k);
    let last = cur;
    const onMove = (ev: PointerEvent) => {
      const items = [...(list.current?.querySelectorAll<HTMLElement>("[data-key]") ?? [])];
      const over = items.find((el) => {
        const r = el.getBoundingClientRect();
        return ev.clientY >= r.top && ev.clientY <= r.bottom && ev.clientX >= r.left && ev.clientX <= r.right;
      });
      const target = over?.dataset.key;
      if (!target || target === k) return;
      const next = last.filter((x) => x !== k);
      next.splice(last.indexOf(target), 0, k);
      last = next;
      setOrder(next);
    };
    const onUp = () => {
      setDragging(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  const save = async (value: string[]) => {
    setBusy(true);
    try {
      await api("/api/owner/feature-order", { method: "PUT", body: { order: value } });
      toast("تم حفظ الترتيب");
      setOrder(null);
      onSaved();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="ترتيب مزايا الباقات"
      action={
        <div className="flex gap-2">
          <button className="btn btn-ghost text-sm" disabled={busy} onClick={() => save([])}>الترتيب الافتراضي</button>
          <button className="btn btn-primary text-sm" disabled={busy || !dirty} onClick={() => save(cur)}>{busy ? "…" : "حفظ الترتيب"}</button>
        </div>
      }
    >
      <p className="muted mb-3 text-sm">امسك أي ميزة من المقبض <Icon name="grip" size={14} className="inline" /> واسحبها لمكانها، أو استخدم الأسهم. نفس الترتيب يظهر في صفحة الباقات وصفحة «اشتراكي».</p>
      <ol ref={list} className="grid max-w-2xl select-none gap-1.5">
        {cur.map((k, i) => (
          <li
            key={k}
            data-key={k}
            className={`surface-2 flex items-center gap-2 rounded-xl px-2 py-1.5 text-sm transition ${dragging === k ? "ring-2 ring-violet-500 opacity-80" : ""}`}
          >
            <button
              type="button"
              aria-label={`اسحب لترتيب: ${label(k)}`}
              onPointerDown={onDown(k)}
              className="muted flex h-9 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg active:cursor-grabbing"
            >
              <Icon name="grip" size={18} />
            </button>
            <span className="font-display w-5 shrink-0 text-center text-xs font-bold text-violet-600 dark:text-violet-300">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate">{label(k)}</span>
            <button type="button" className="btn btn-ghost min-h-8 px-2" aria-label="لأعلى" disabled={i === 0} onClick={() => move(k, i - 1)}>↑</button>
            <button type="button" className="btn btn-ghost min-h-8 px-2" aria-label="لأسفل" disabled={i === cur.length - 1} onClick={() => move(k, i + 1)}>↓</button>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function BannerUpload({ variant, current, onSaved }: { variant: "desktop" | "mobile"; current: string | null; onSaved: () => void }) {
  const size = BANNER_SIZES[variant];
  const [busy, setBusy] = useState(false);
  const save = async (image: string | null) => {
    setBusy(true);
    try {
      await api("/api/owner/login-banner", { method: "PUT", body: { variant, image } });
      toast(image ? "تم حفظ الصورة" : "رجعت الخلفية الافتراضية");
      onSaved();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <b className="font-display">صورة {size.label}</b>
        <span className={`chip ${current ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "surface-2 muted"}`}>{current ? "صورة مخصّصة" : "الخلفية الافتراضية"}</span>
      </div>
      <div className="rounded-2xl bg-[var(--surface-2)] px-3 py-2 text-xs leading-relaxed">
        المقاس المقترح: <b dir="ltr">{size.w} × {size.h}</b> بكسل ({size.ratio})
        <br />
        بالسنتيمتر: <b dir="ltr">{toCm(size.w)} × {toCm(size.h)}</b> سم <span className="muted">(بدقة 72 بكسل/إنش)</span>
        {variant === "mobile" && <span className="muted block">إذا ما رفعت صورة للجوال تُستخدم صورة الكمبيوتر.</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        <label className={`btn btn-primary min-h-9 cursor-pointer text-xs ${busy ? "pointer-events-none opacity-60" : ""}`}>
          <Icon name="upload" size={15} />{current ? "تغيير الصورة" : "رفع صورة"}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              try {
                await save(await shrinkImage(f, size.w, size.h, 0.82));
              } catch (err: any) {
                toast(err.message, "bad");
              }
            }}
          />
        </label>
        {current && <button className="btn btn-ghost min-h-9 text-xs" disabled={busy} onClick={async () => (await askConfirm({ title: "الرجوع للخلفية الافتراضية؟", message: "تنحذف الصورة اللي رفعتها.", confirmLabel: "استرجاع الافتراضي" })) && save(null)}><Icon name="refresh" size={15} />الرجوع للخلفية الافتراضية</button>}
      </div>
    </div>
  );
}

function BrandingTab() {
  const { data, reload } = useAsync(() => api<Branding>("/api/public/branding"), []);
  const [texts, setTexts] = useState<BannerTexts | null>(null);
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  const [appIcon, setAppIcon] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  if (!data) return <Spinner />;
  const icon = appIcon === undefined ? data.app_icon ?? null : appIcon;
  const abs = (p: string | null) => (p ? `${API_BASE || ""}${p}` : null);
  const t = texts ?? data.texts ?? DEFAULT_TEXTS;
  const lg = logo === undefined ? data.logo : logo;
  const save = async (body: { texts: BannerTexts | null; logo: string | null; app_icon?: string | null }, msg: string) => {
    setBusy(true);
    try {
      await api("/api/owner/branding", { method: "PUT", body });
      toast(msg);
      setTexts(null);
      setLogo(undefined);
      setAppIcon(undefined);
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const desktopImg = abs(data.login_banner);
  const mobileImg = abs(data.login_banner_mobile) ?? desktopImg;
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_440px]">
      <div className="space-y-5">
        <Card title="صور البنر">
          <div className="grid gap-6 md:grid-cols-2">
            <BannerUpload variant="desktop" current={data.login_banner} onSaved={reload} />
            <BannerUpload variant="mobile" current={data.login_banner_mobile} onSaved={reload} />
          </div>
        </Card>
        <Card title="النصوص والشعار">
          <div className="space-y-3">
            <Field label="الشعار (اختياري)" hint="يظهر أعلى البنر — يفضّل PNG بخلفية شفافة"><LogoPicker value={lg ?? null} onChange={setLogo} /></Field>
            <Field label="العنوان" hint="سطر جديد = انتقال للسطر الثاني في الكمبيوتر">
              <textarea className="input min-h-[72px]" value={t.title} onChange={(e) => setTexts({ ...t, title: e.target.value })} maxLength={120} />
            </Field>
            <Field label="الوصف"><textarea className="input min-h-[72px]" value={t.subtitle} onChange={(e) => setTexts({ ...t, subtitle: e.target.value })} maxLength={300} /></Field>
            <div className="font-display text-[13px] font-bold text-[var(--text-2)]">النقاط ({t.points.length} من 6)</div>
            {t.points.map((p, i) => (
              <PointEditor
                key={i}
                i={i}
                point={p}
                count={t.points.length}
                onChange={(v) => setTexts({ ...t, points: t.points.map((x, j) => (j === i ? v : x)) })}
                onRemove={() => setTexts({ ...t, points: t.points.filter((_, j) => j !== i) })}
                onMove={(d) => {
                  const pts = [...t.points];
                  [pts[i], pts[i + d]] = [pts[i + d], pts[i]];
                  setTexts({ ...t, points: pts });
                }}
              />
            ))}
            {t.points.length < 6 && (
              <button type="button" className="btn btn-ghost w-full" onClick={() => setTexts({ ...t, points: [...t.points, { title: "", desc: "", icon: "" }] })}>
                <Icon name="plus" size={15} />إضافة نقطة
              </button>
            )}
            <Field label="أيقونة زر «تنزيل التطبيق للأندرويد»" hint="تظهر جنب النص في أسفل البنر — PNG بدون خلفية. الزر يحمّل التطبيق مباشرة.">
              <LogoPicker value={icon} onChange={setAppIcon} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary flex-1" disabled={busy} onClick={() => save({ texts: t, logo: lg ?? null, app_icon: icon }, "تم حفظ النصوص والشعار")}>حفظ</button>
              <button className="btn btn-ghost" disabled={busy} onClick={async () => (await askConfirm({ title: "استرجاع النصوص الافتراضية؟", message: "ترجع النصوص الأصلية وينشال الشعار.", confirmLabel: "استرجاع الافتراضي" })) && save({ texts: null, logo: null }, "رجعت النصوص الافتراضية")}><Icon name="refresh" size={15} />النصوص الافتراضية</button>
            </div>
          </div>
        </Card>
      </div>
      <Card title="المعاينة">
        <p className="muted mb-3 text-xs">معاينة مباشرة بالتعديلات قبل الحفظ.</p>
        <div className="space-y-5">
          <div>
            <div className="muted mb-1.5 text-xs font-bold">الكمبيوتر</div>
            <div className="relative mx-auto h-[450px] w-[320px] overflow-hidden rounded-2xl ring-1 ring-[var(--border)]">
              <div className="pointer-events-none absolute right-0 top-0 h-[900px] w-[640px] origin-top-right scale-50">
                <DesktopBanner className="flex h-full w-full" image={desktopImg} texts={t} logo={lg ?? null} download={data.app_download_url ? { url: "#", icon } : null} />
              </div>
            </div>
          </div>
          <div>
            <div className="muted mb-1.5 text-xs font-bold">الجوال</div>
            <div className="mx-auto w-[320px] overflow-hidden rounded-2xl bg-[var(--bg)] ring-1 ring-[var(--border)]">
              <MobileBanner image={mobileImg} texts={t} logo={lg ?? null} />
              <div className="space-y-2 p-4"><div className="h-3 w-24 rounded bg-[var(--border)]" /><div className="h-9 rounded-xl bg-[var(--surface)]" /><div className="h-9 rounded-xl bg-[var(--surface)]" /></div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** A small transparent PNG for a banner point (96px, kept as PNG so the transparency stays). */
async function pointPng(file: File): Promise<string> {
  if (file.type !== "image/png") throw new Error("الأيقونة لازم تكون PNG");
  if (file.size > 5 * 1024 * 1024) throw new Error("الصورة كبيرة جدًا");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("تعذّر قراءة الصورة"));
      i.src = url;
    });
    const scale = Math.min(1, 96 / img.width, 96 / img.height);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** One banner point: title, description, and its icon (built-in / uploaded PNG / Remix Icon name). */
function PointEditor({ i, point, count, onChange, onRemove, onMove }: { i: number; point: BannerTexts["points"][number]; count: number; onChange: (p: BannerTexts["points"][number]) => void; onRemove: () => void; onMove: (d: -1 | 1) => void }) {
  const icon = point.icon ?? "";
  const kind = icon.startsWith("data:") ? "png" : icon.startsWith("ri:") ? "remix" : "default";
  const [name, setName] = useState(kind === "remix" ? icon.slice(3) : "");
  const [bad, setBad] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const applyName = async (v: string) => {
    setName(v);
    const n = remixName(v);
    if (!n) return setBad(false);
    const ok = /^[a-z0-9-]{1,60}$/.test(n) && (await remixExists(n));
    setBad(!ok);
    if (ok) onChange({ ...point, icon: `ri:${n}` });
  };
  return (
    <div className="space-y-2 rounded-2xl border border-[var(--border)] p-3">
      <div className="flex items-center gap-2">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white" style={{ background: "linear-gradient(160deg,#4c1d95,#86198f)" }}><PointIcon icon={icon} i={i} size={20} /></span>
        <b className="flex-1 text-sm">النقطة {i + 1}</b>
        <button type="button" className="btn btn-ghost min-h-8 px-2 text-xs" disabled={i === 0} onClick={() => onMove(-1)} aria-label="لفوق">▲</button>
        <button type="button" className="btn btn-ghost min-h-8 px-2 text-xs" disabled={i === count - 1} onClick={() => onMove(1)} aria-label="لتحت">▼</button>
        <button type="button" className="btn btn-ghost min-h-8 px-2 text-xs text-red-600" disabled={count <= 1} onClick={onRemove}>حذف</button>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1.4fr]">
        <input className="input" value={point.title} onChange={(e) => onChange({ ...point, title: e.target.value })} maxLength={60} aria-label={`عنوان النقطة ${i + 1}`} />
        <input className="input" value={point.desc} onChange={(e) => onChange({ ...point, desc: e.target.value })} maxLength={120} aria-label={`وصف النقطة ${i + 1}`} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="muted">الأيقونة:</span>
        <button type="button" className={`rounded-lg border px-2.5 py-1 font-bold ${kind === "default" ? "border-violet-500 bg-violet-500/10" : "border-[var(--border)] muted"}`} onClick={() => onChange({ ...point, icon: "" })}>الأساسية</button>
        <button type="button" className={`rounded-lg border px-2.5 py-1 font-bold ${kind === "png" ? "border-violet-500 bg-violet-500/10" : "border-[var(--border)] muted"}`} onClick={() => fileRef.current?.click()}>رفع PNG</button>
        <input ref={fileRef} type="file" accept="image/png" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; try { onChange({ ...point, icon: await pointPng(f) }); } catch (err: any) { toast(err.message, "bad"); } }} />
        <input className={`input min-h-8 max-w-[210px] py-1 text-xs ${bad ? "border-red-500" : ""}`} dir="ltr" value={name} onChange={(e) => applyName(e.target.value)} placeholder="Remix Icon: rocket-line" aria-label="اسم أيقونة Remix Icon" />
        <a className="font-semibold text-violet-700 underline dark:text-violet-300" href="https://remixicon.com" target="_blank" rel="noopener">تصفّح الأيقونات</a>
      </div>
      {bad && <p className="text-xs text-red-600">ما لقينا أيقونة بهذا الاسم — انسخ الاسم من remixicon.com (مثل rocket-line)</p>}
    </div>
  );
}

/** A notice to every active customer's bell — in plain words, without technical details. */
function BroadcastCard() {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState("/");
  const [days, setDays] = useState(7);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!(await askConfirm({ title: "إرسال لكل العملاء؟", message: `يوصل الإشعار في جرس «الإشعارات المهمة» عند كل العملاء النشطين:\n\n${title}`, confirmLabel: "أرسل" }))) return;
    setBusy(true);
    try {
      const r = await api<{ sent: number }>("/api/owner/broadcast", { body: { title, body: body || undefined, link, days } });
      toast(`وصل لـ ${r.sent} عميل`);
      setOpen(false);
      setTitle("");
      setBody("");
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="📢 إشعار لكل العملاء" action={!open && <button className="btn btn-ghost min-h-9 text-xs" onClick={() => setOpen(true)}>إشعار جديد</button>}>
      {!open ? (
        <p className="muted text-sm">لصيانة أو توقف مؤقت أو رجوع الخدمة — يوصل في جرس «الإشعارات المهمة» عند كل العملاء النشطين، بكلام بسيط بدون تفاصيل تقنية.</p>
      ) : (
        <div className="space-y-3">
          <TemplateBar kind="notice" current={{ title, body, link, days }} onPick={(t) => { setTitle(t.title); setBody(t.body); setLink(t.link); setDays(t.days); }} />
          <input className="input" placeholder="العنوان" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea className="input min-h-[6rem]" placeholder="التفاصيل (اختياري)" maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} />
          <PlaceholderChips onInsert={(k) => setBody((b) => `${b}${b && !b.endsWith(" ") ? " " : ""}${k}`)} />
          <div className="grid gap-3 sm:grid-cols-2"><LinkSelect value={link} onChange={setLink} /><DaysSelect value={days} onChange={setDays} /></div>
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy || title.trim().length < 3} onClick={send}>{busy ? "…" : "إرسال للعملاء"}</button>
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>إلغاء</button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** A private message from the owner to one customer: their bell, and their Telegram when they set it up. */
function DaysSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="muted text-xs">تبقى في إشعارات العميل لمدة:</span>
      <select className="input mt-1" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {[3, 7, 30, 90].map((d) => <option key={d} value={d}>{d === 3 ? "3 أيام" : d === 7 ? "أسبوع" : d === 30 ? "شهر" : "3 شهور"}</option>)}
      </select>
    </label>
  );
}

function LinkSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="muted text-xs">لما يضغط على الرسالة يروح إلى:</span>
      <select className="input mt-1" value={value} onChange={(e) => onChange(e.target.value)}>
        {MESSAGE_LINKS.map((l) => <option key={l.to} value={l.to}>{l.label}</option>)}
      </select>
    </label>
  );
}

function MessageModal({ tenant, onClose }: { tenant: any; onClose: () => void }) {
  const [link, setLink] = useState("/");
  const [days, setDays] = useState(30);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api<{ telegram: boolean }>(`/api/owner/tenants/${tenant.id}/message`, { body: { title, body: body || undefined, link, days } });
      toast(r.telegram ? "وصلت الرسالة (في التطبيق وتيليجرام)" : "وصلت الرسالة في التطبيق");
      onClose();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`رسالة إلى «${tenant.name}»`} center>
      <div className="space-y-3">
        <p className="muted text-xs">توصل في جرس «الإشعارات المهمة» عنده مع صوت تنبيه ووميض بسيط في الشريط العلوي، وعلى تيليجرام إذا مفعّله. هو بس اللي يشوفها.</p>
        <TemplateBar kind="private" current={{ title, body, link, days }} onPick={(t) => { setTitle(t.title); setBody(t.body); setLink(t.link); setDays(t.days); }} />
        <input className="input" placeholder="العنوان (مثل: تجديد اشتراكك، ميزة جديدة لك…)" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="input min-h-[8rem]" placeholder="نص الرسالة" maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} />
        <PlaceholderChips onInsert={(k) => setBody((b) => `${b}${b && !b.endsWith(" ") ? " " : ""}${k}`)} />
        <div className="grid gap-3 sm:grid-cols-2"><LinkSelect value={link} onChange={setLink} /><DaysSelect value={days} onChange={setDays} /></div>
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>إلغاء</button>
          <button className="btn btn-primary" disabled={busy || title.trim().length < 3} onClick={send}>{busy ? "…" : "إرسال"}</button>
        </div>
      </div>
    </Modal>
  );
}

const RISK: Record<string, { label: string; cls: string }> = {
  high: { label: "خطر — تابعه الحين", cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300" },
  medium: { label: "يحتاج متابعة", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" },
  good: { label: "بخير", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" },
  off: { label: "موقوف", cls: "surface-2 muted" },
};

/** Customer health: who may be about to leave, why, and a message button. */
function HealthTab() {
  const { data, reload } = useAsync(() => api<any>("/api/owner/health"), []);
  const [messageFor, setMessageFor] = useState<any | null>(null);
  const [diagnoseFor, setDiagnoseFor] = useState<any | null>(null);
  const [filter, setFilter] = useState<"all" | "high" | "medium" | "good">("all");
  if (!data) return <Spinner />;
  const list = data.customers.filter((c: any) => filter === "all" || c.risk === filter);
  const count = (r: string) => data.customers.filter((c: any) => c.risk === r).length;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        {(["high", "medium", "good"] as const).map((r) => (
          <button key={r} type="button" onClick={() => setFilter(filter === r ? "all" : r)} className={`card p-3 text-right ${filter === r ? "ring-2 ring-violet-500" : ""}`}>
            <div className="muted text-xs">{RISK[r].label}</div>
            <div className="font-display text-2xl font-extrabold">{count(r)}</div>
          </button>
        ))}
      </div>
      {!list.length ? <Empty title="ما فيه عملاء هنا" /> : (
        <div className="grid gap-3 md:grid-cols-2">
          {list.map((c: any) => (
            <Card key={c.id} title={<span className="flex items-center gap-2">{c.name}<span className={`chip !py-0 text-[10.5px] ${RISK[c.risk].cls}`}>{RISK[c.risk].label}</span></span>} action={<span className="flex gap-1"><button className="btn btn-ghost min-h-9 text-xs" onClick={() => setDiagnoseFor(c)}>🩺 تشخيص</button><button className="btn btn-ghost min-h-9 text-xs" onClick={() => setMessageFor(c)}><Icon name="send" size={14} />رسالة</button></span>}>
              <div className="muted mb-2 text-xs">
                اسم المستخدم: <b className="text-[var(--text)]">{c.name}</b> · اسم المتجر (الدخول): <b className="text-[var(--text)]" dir="ltr">{c.usernames ?? "—"}</b>
                {c.ig_username ? <> · إنستقرام: <b className="text-[var(--text)]" dir="ltr">@{c.ig_username}</b></> : null}
                {c.store_name ? <> · المتجر: <b className="text-[var(--text)]">🛍️ {c.store_name}</b></> : null}
              </div>
              {c.reasons.length > 0 && (
                <ul className="mb-3 space-y-1 text-sm">
                  {c.reasons.map((r: string) => <li key={r}>• {r}</li>)}
                </ul>
              )}
              <dl className="muted grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <div>الباقة: <b className="text-[var(--text)]">{c.plan ?? "—"}</b>{c.days_left !== null ? ` · باقي ${c.days_left} يوم` : ""}</div>
                <div>آخر دخول: <b className="text-[var(--text)]">{c.last_seen ? fmtTime(c.last_seen) : "أبدًا"}</b></div>
                <div>حملات شغّالة: <b className="text-[var(--text)]">{c.active_campaigns}</b></div>
                <div>تفاعل آخر 7 أيام: <b className="text-[var(--text)]">{c.people_7d}</b></div>
                <div>الرسائل: <b className="text-[var(--text)]">{c.messages.used.toLocaleString("en-US")}{c.messages.limit ? ` / ${c.messages.limit.toLocaleString("en-US")}` : ""}</b></div>
                <div>إنستقرام: <b className="text-[var(--text)]">{c.ig_status === "active" ? "متصل" : c.ig_status ? "يحتاج إعادة ربط" : "غير مربوط"}</b></div>
              </dl>
            </Card>
          ))}
        </div>
      )}
      <button className="btn btn-ghost text-xs" onClick={reload}>تحديث</button>
      {messageFor && <MessageModal tenant={messageFor} onClose={() => setMessageFor(null)} />}
      {diagnoseFor && <DiagnoseModal tenant={diagnoseFor} onClose={() => setDiagnoseFor(null)} />}
    </div>
  );
}

/** Subscription discount codes and the referral reward. */
function CouponsTab() {
  const { data, reload } = useAsync(() => api<any>("/api/owner/coupons"), []);
  const { data: plans } = useAsync(() => api<any>("/api/public/plans").then((r) => r.plans as any[]).catch(() => []), []);
  const [f, setF] = useState({ code: "", percent: "20", plans: [] as string[], expires: "", max: "", note: "" });
  const [days, setDays] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      await api("/api/owner/coupons", {
        body: {
          code: f.code,
          percent: Number(f.percent),
          plan_ids: f.plans.length ? f.plans : null,
          expires_at: f.expires ? new Date(`${f.expires}T23:59:59`).getTime() : null,
          max_uses: f.max ? Number(f.max) : null,
          note: f.note || null,
        },
      });
      toast("تم إنشاء الكوبون");
      setF({ code: "", percent: "20", plans: [], expires: "", max: "", note: "" });
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  if (!data) return <Spinner />;
  return (
    <div className="space-y-4">
      <Card title="🎁 مكافأة الإحالة">
        <p className="muted mb-3 text-sm">كل عميل عنده رابط دعوة في صفحة «اشتراكي». إذا اشترك عميل جديد من رابطه (بكود تفعيل)، ينضاف للطرفين عدد الأيام هذا على اشتراكهم. 0 = إيقاف الإحالة.</p>
        <div className="flex flex-wrap items-center gap-2">
          <input className="input !w-24" inputMode="numeric" value={days ?? String(data.referral_days)} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} />
          <span className="muted text-sm">يوم لكل طرف</span>
          <button className="btn btn-primary min-h-10" disabled={days === null} onClick={async () => { await api("/api/owner/referral", { method: "PUT", body: { days: Number(days) } }).then(() => toast("تم الحفظ")).catch((e) => toast(e.message, "bad")); setDays(null); reload(); }}>حفظ</button>
        </div>
      </Card>
      <Card title="كوبون خصم جديد">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="الكود"><input className="input" dir="ltr" placeholder="RAMADAN20" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "") })} maxLength={30} /></Field>
          <Field label="نسبة الخصم %"><input className="input" inputMode="numeric" value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value.replace(/\D/g, "") })} /></Field>
          <Field label="ينتهي في (اختياري)"><input className="input" type="date" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} /></Field>
          <Field label="أقصى عدد استخدامات (اختياري)"><input className="input" inputMode="numeric" value={f.max} onChange={(e) => setF({ ...f, max: e.target.value.replace(/\D/g, "") })} /></Field>
        </div>
        <div className="mt-3">
          <span className="muted text-xs">الباقات (بدون اختيار = كل الباقات):</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {(plans ?? []).map((p: any) => (
              <button key={p.id} type="button" className={`chip ${f.plans.includes(p.id) ? "grad text-white" : "surface-2"}`} onClick={() => setF({ ...f, plans: f.plans.includes(p.id) ? f.plans.filter((x) => x !== p.id) : [...f.plans, p.id] })}>{p.name}</button>
            ))}
          </div>
        </div>
        <input className="input mt-3" placeholder="ملاحظة لك (اختياري): مثل حملة رمضان" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={120} />
        <button className="btn btn-primary mt-3" disabled={busy || f.code.length < 3 || !(Number(f.percent) >= 1 && Number(f.percent) <= 100)} onClick={create}>{busy ? "…" : "إنشاء الكوبون"}</button>
        <p className="muted mt-2 text-xs">العميل يكتب الكود في صفحة الباقات فيشوف السعر بعد الخصم، والكود ينكتب في رسالة السند اللي يرسلها لك. «الاستخدامات» = كم مرة أُرسل سند بهذا الكود.</p>
      </Card>
      <Card title="الكوبونات">
        {!data.coupons.length ? <p className="muted text-sm">ما فيه كوبونات بعد.</p> : (
          <div className="divide-y divide-[var(--border)]">
            {data.coupons.map((c: any) => (
              <div key={c.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <span className="chip surface-2 font-mono" dir="ltr">{c.code}</span>
                <b>{c.percent}%</b>
                <span className="muted min-w-0 flex-1 truncate text-xs">
                  {c.plan_ids ? `باقات: ${JSON.parse(c.plan_ids).join("، ")}` : "كل الباقات"}
                  {c.expires_at ? ` · ينتهي ${fmtDate(c.expires_at)}` : ""} · استُخدم {c.uses}{c.max_uses ? ` / ${c.max_uses}` : ""}{c.note ? ` · ${c.note}` : ""}
                </span>
                <Toggle checked={!!c.active} onChange={async (v) => { await api(`/api/owner/coupons/${c.id}`, { method: "PUT", body: { active: v } }); reload(); }} label={c.active ? "فعّال" : "موقوف"} />
                <button className="btn btn-ghost min-h-8 text-xs text-red-600" onClick={async () => { if (await askConfirm({ title: `حذف ${c.code}؟`, message: "ما يقدر أحد يستخدمه بعدها.", confirmLabel: "حذف", danger: true })) { await api(`/api/owner/coupons/${c.id}`, { method: "DELETE" }); reload(); } }}>حذف</button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

const LINK_LABEL = Object.fromEntries(MESSAGE_LINKS.map((l) => [l.to, l.label]));

/** Messages and notices already sent: who read them, opened the link; remind (rings again), delete. */
function SentMessages() {
  const { data, reload, loading } = useAsync(() => api<any[]>("/api/owner/messages"), []);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  // While the list is open it refreshes itself every 30 seconds (read / opened the link).
  useEffect(() => {
    if (!open) return;
    const t = setInterval(reload, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!data || !data.length) return null;
  const clearAll = async () => {
    if (!(await askConfirm({ title: "حذف كل الرسائل المرسلة؟", message: `تنحذف ${data.length} رسالة من سجلك ومن إشعارات كل العملاء. ما يمكن التراجع.`, confirmLabel: "حذف الكل", danger: true }))) return;
    await api("/api/owner/messages", { method: "DELETE" }).then(() => toast("تم حذف كل الرسائل")).catch((e) => toast(e.message, "bad"));
    reload();
  };
  return (
    <Card
      title={`📨 الرسائل المرسلة (${data.length})`}
      action={
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ghost min-h-9 text-xs" disabled={loading} onClick={reload}><Icon name="refresh" size={14} />{loading ? "…" : "تحديث"}</button>
          {open && <button className="btn btn-ghost min-h-9 text-xs text-red-600" onClick={clearAll}>حذف الكل</button>}
          <button className="btn btn-ghost min-h-9 text-xs" onClick={() => setOpen(!open)}>{open ? "إخفاء" : "عرض"}</button>
        </div>
      }
    >
      {open && <p className="muted mb-2 text-[11px]">🟠 ما قرأها · 🟢 قرأها · 🔵 فتح الرابط · ⚪ حذفها من عنده — كل مرحلة تنحفظ عندك حتى لو حذفها. اضغط على أي رسالة لتفاصيلها. تتحدث تلقائيًا كل 30 ثانية.</p>}
      {!open ? <p className="muted text-sm">رسائلك السابقة للعملاء: تقدر تذكّرهم فيها مرة ثانية (يوصلهم صوت ووميض) أو تحذفها من عندهم.</p> : (
        <div className="divide-y divide-[var(--border)]">
          {data.map((m) => (
            <div key={m.id} className="py-3">
              <div className="flex flex-wrap items-start gap-3">
                <button type="button" className="min-w-0 flex-1 text-right" onClick={() => setExpanded(expanded === m.id ? null : m.id)} aria-expanded={expanded === m.id}>
                  <div className="text-sm font-semibold">{expanded === m.id ? "▾" : "◂"} {m.title}</div>
                  <div className="muted text-xs">
                    {m.tenant_id ? (
                      <>إلى: <b className="text-[var(--text)]">{m.tenant_name ?? "عميل محذوف"}</b>{m.tenant_usernames ? <> · اسم المتجر: <b className="text-[var(--text)]" dir="ltr">{m.tenant_usernames}</b></> : null}</>
                    ) : "إلى: كل العملاء"}
                    {" · "}{fmtTime(m.created_at)}
                    {m.reminders ? ` · ذكّرت ${m.reminders} مرة` : ""}
                  </div>
                </button>
                <ReadBox copies={m.copies} read={m.read} clicked={m.clicked} deleted={m.deleted} single={!!m.tenant_id} />
              </div>
              {expanded === m.id && <MessageDetail m={m} onChange={() => { setExpanded(null); reload(); }} />}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** The full message, where it leads, who got it (per customer for a notice), and its actions. */
function MessageDetail({ m, onChange }: { m: any; onChange: () => void }) {
  const { data: who } = useAsync(() => api<any[]>(`/api/owner/messages/${m.id}`), [m.id]);
  return (
    <div className="surface-2 mt-2 space-y-3 rounded-2xl p-3 text-sm">
      <div>
        <div className="muted text-xs">الموضوع</div>
        <div className="font-semibold">{m.title}</div>
      </div>
      <div>
        <div className="muted text-xs">نص الرسالة</div>
        <p className="whitespace-pre-wrap">{m.body || <span className="muted">بدون نص</span>}</p>
        {/\{[^}]+\}/.test(`${m.title} ${m.body ?? ""}`) && <p className="muted mt-1 text-[11px]">الكلمات بين {"{ }"} تعبّت تلقائي لكل عميل ببياناته وقت الإرسال.</p>}
      </div>
      <div className="muted grid gap-1 text-xs sm:grid-cols-3">
        <div>يفتح على: <b className="text-[var(--text)]">{LINK_LABEL[m.link ?? "/"] ?? m.link}</b></div>
        <div>تبقى عنده: <b className="text-[var(--text)]">{m.keep_days} يوم</b></div>
        <div>أُرسلت: <b className="text-[var(--text)]">{fmtTime(m.created_at)}</b>{m.reminded_at ? ` · آخر تذكير ${fmtTime(m.reminded_at)}` : ""}</div>
      </div>
      {m.tenant_id && who?.[0] && <Stages w={who[0]} />}
      {!m.tenant_id && who && who.length > 0 && (
        <div>
          <div className="muted mb-1 text-xs">العملاء ({who.length})</div>
          <div className="max-h-48 divide-y divide-[var(--border)] overflow-y-auto rounded-xl bg-[var(--surface)] px-3">
            {who.map((w) => (
              <div key={w.tenant_id} className="space-y-1 py-2 text-xs">
                <span className="block truncate"><b>{w.tenant_name}</b>{w.tenant_usernames ? <span className="muted" dir="ltr"> · {w.tenant_usernames}</span> : null}</span>
                <Stages w={w} compact />
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-ghost min-h-9 text-xs" onClick={async () => { try { const r = await api<{ sent: number }>(`/api/owner/messages/${m.id}/remind`, { body: {} }); toast(`وصل التذكير لـ ${r.sent}`); onChange(); } catch (e: any) { toast(e.message, "bad"); } }}>🔔 تذكير</button>
        <button className="btn btn-ghost min-h-9 text-xs text-red-600" onClick={async () => { if (await askConfirm({ title: "حذف الرسالة؟", message: "تنحذف من سجلك ومن إشعارات العملاء.", confirmLabel: "حذف", danger: true })) { await api(`/api/owner/messages/${m.id}`, { method: "DELETE" }); onChange(); } }}>حذف</button>
      </div>
    </div>
  );
}

const TONE = {
  blue: "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
  green: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  orange: "border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  grey: "border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300",
} as const;
const box = (t: keyof typeof TONE, text: string, small = false) => <span className={`shrink-0 rounded-xl border font-bold ${small ? "px-2 py-0.5 text-[10.5px]" : "px-3 py-1.5 text-xs"} ${TONE[t]}`}>{text}</span>;

/**
 * Status of a sent message, from the permanent record (kept even after the customer deletes it):
 * blue = opened the link, green = read, orange = not yet, grey = removed from their bell (shown alongside).
 */
function ReadBox({ copies, read, clicked, deleted, single }: { copies: number; read: number; clicked: number; deleted: number; single: boolean }) {
  if (!copies) return box("grey", "ما وصلت لأحد");
  if (single)
    return (
      <span className="flex shrink-0 flex-wrap gap-1.5">
        {clicked ? box("blue", "🔗 فتح الرابط") : read ? box("green", "✓ قرأها") : box("orange", "● ما قرأها")}
        {deleted > 0 && box("grey", "🗑 حذفها من عنده")}
      </span>
    );
  return (
    <span className="flex shrink-0 flex-wrap gap-1.5">
      {box(read >= copies ? "green" : "orange", `قرأها ${read} من ${copies}`)}
      {clicked > 0 && box("blue", `🔗 فتح الرابط ${clicked}`)}
      {deleted > 0 && box("grey", `🗑 حذفها ${deleted}`)}
    </span>
  );
}

/** Every stage for one customer, with its time: delivered → read → opened the link → removed / expired. */
function Stages({ w, compact }: { w: any; compact?: boolean }) {
  const step = (done: boolean, tone: keyof typeof TONE, label: string, at?: number | null) =>
    done ? box(tone, `${label}${at ? ` · ${fmtTime(at)}` : ""}`, compact) : box("orange", `● ${label === "قرأها" ? "ما قرأها" : `ما ${label}`}`, compact);
  return (
    <div className={compact ? "flex flex-wrap gap-1" : "space-y-1.5"}>
      {!compact && <div className="muted text-xs">مراحل الرسالة (تنحفظ حتى لو حذفها):</div>}
      <div className="flex flex-wrap gap-1.5">
        {box("grey", `📬 وصلت · ${fmtTime(w.delivered_at)}${w.last_delivered_at > w.delivered_at ? ` · آخر تذكير ${fmtTime(w.last_delivered_at)}` : ""}`, compact)}
        {step(!!w.read_at, "green", "قرأها", w.read_at)}
        {step(!!w.clicked_at, "blue", "فتح الرابط", w.clicked_at)}
        {w.deleted_at ? box("grey", `🗑 حذفها من عنده · ${fmtTime(w.deleted_at)}`, compact) : !w.on_bell ? box("grey", "⌛ انتهت مدتها عنده", compact) : null}
      </div>
    </div>
  );
}
