import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { askConfirm, askText, showCopy } from "../components/Confirm";
import { api } from "../api";
import { API_BASE } from "../platform";
import { BANNER_SIZES, DEFAULT_TEXTS, DesktopBanner, MobileBanner, toCm, type BannerTexts, type Branding } from "../components/LoginBanner";
import { Icon } from "../components/Icon";
import { Alert, Card, Empty, Field, Modal, Spinner, Tip, Toggle, fmtDate, fmtTime, toast, useAsync } from "../components/ui";
import { CURRENCIES, EVENT_LABELS, FEATURE_HINTS, FEATURE_LABELS, LIMIT_HINTS, LIMIT_ROW_LABELS, PRICE_PERIODS, formatPrice, orderFeatures } from "../../shared/plans";

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
    const text = `بيانات دخولك على HSN AutoReply:\nاسم المستخدم: ${created.username}\nكلمة المرور: ${created.password}\n${location.origin}`;
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
        <Field label="اسم العميل (المتجر أو الشخص)"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
        <Field label="اسم المستخدم للدخول" hint="أحرف إنجليزية وأرقام فقط، مثل: shop_noor">
          <input className="input" dir="ltr" value={username} onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))} maxLength={64} />
        </Field>
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

function CustomersTab() {
  const { data, loading, error, reload } = useAsync(() => api<any[]>("/api/owner/tenants"), []);
  const { data: plans } = useAsync(() => api<any[]>("/api/owner/plans"), []);
  const [planFor, setPlanFor] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  const customers = (data ?? []).filter((t) => !t.is_owner);
  return (
    <div className="space-y-5">
      {adding && <NewCustomer onClose={() => setAdding(false)} onDone={reload} />}
      {planFor && <SetPlan t={planFor} plans={plans ?? []} onClose={() => setPlanFor(null)} onDone={() => { setPlanFor(null); reload(); }} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="muted text-sm">{data ? `${customers.length} عميل · ${customers.filter((t) => t.status === "active" && t.plan_expires_at > Date.now()).length} باشتراك فعّال` : ""}</p>
        <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={18} />عميل جديد</button>
      </div>
      {loading && !data ? <Spinner /> : error ? <Alert tone="bad">{error}</Alert> : !customers.length ? (
        <Empty title="لا يوجد عملاء بعد">اضغط «عميل جديد» لإنشاء أول حساب.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {customers.map((t) => (
            <Card key={t.id} className={t.status !== "active" ? "opacity-70" : ""}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <b className="font-display block truncate text-base">{t.name}</b>
                  <span className="muted block text-xs" dir="ltr" style={{ textAlign: "right" }}>{t.username}</span>
                </div>
                <span className={`chip ${t.status === "active" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"}`}>
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />{t.status === "active" ? "نشط" : "موقوف"}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <div><b className="font-display block text-base">{t.ig_username ? `@${t.ig_username}` : "—"}</b><span className="muted">{t.ig_status === "active" ? "إنستقرام متصل" : t.ig_username ? "غير متصل" : "لم يربط بعد"}</span></div>
                <div><b className="font-display block text-base">{t.active_campaigns}/{t.campaigns}</b><span className="muted">حملات نشطة</span></div>
                <div><b className="font-display block text-base">{t.flows_30d}</b><span className="muted">تفاعل (30 يوم)</span></div>
              </div>
              <SubscriptionBar t={t} onEdit={() => setPlanFor(t)} />
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
      <div className="muted mt-1.5 flex justify-between text-[11px]">
        <span>{exp ? `${active ? "ينتهي" : "انتهى"} ${fmtDate(exp)}` : "اضغط لتعيين باقة"}</span>
        <span>رسائل الشهر: {(t.messages_month ?? 0).toLocaleString("en-US")}</span>
      </div>
    </button>
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
          <div className="flex gap-2">
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
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
];

function PlansTab() {
  const { data, reload } = useAsync(() => api<any[]>("/api/owner/plans"), []);
  const { data: catalog, reload: reloadCatalog } = useAsync(() => api<any>("/api/public/plans"), []);
  const { data: settings, reload: reloadSettings } = useAsync(() => api<{ sales_contact: string; app_download_url: string; exchange_rates: Record<string, number> }>("/api/owner/settings"), []);
  const [contact, setContact] = useState<string | null>(null);
  const [download, setDownload] = useState<string | null>(null);
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
  const [f, setF] = useState(() => ({ ...plan, limits: { ...plan.limits } }));
  const [busy, setBusy] = useState(false);
  const setL = (k: string, v: unknown) => setF((x: any) => ({ ...x, limits: { ...x.limits, [k]: v } }));
  const save = async () => {
    setBusy(true);
    try {
      const amount = f.price_amount === "" || f.price_amount === null || f.price_amount === undefined ? null : Number(f.price_amount);
      await api(`/api/owner/plans/${plan.id}`, {
        method: "PUT",
        body: { name: f.name, price_amount: amount, price_currency: f.price_currency || "SAR", price_period: f.price_period || "month", description: f.description || undefined, active: !!f.active, limits: f.limits },
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
  const [tab, setTab] = useState<"customers" | "plans" | "codes" | "payments" | "branding">("customers");
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-extrabold leading-tight sm:text-[26px]">العملاء والاشتراكات</h1>
        <p className="muted mt-1 text-sm">العملاء، الباقات، وأكواد التفعيل — لإدارة الخدمة فقط.</p>
      </header>
      <div className="seg w-fit max-w-full overflow-x-auto" role="tablist">
        {([["customers", "العملاء"], ["plans", "الباقات"], ["codes", "أكواد التفعيل"], ["payments", "الحسابات البنكية"], ["branding", "صفحة الدخول"]] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === "customers" ? <CustomersTab /> : tab === "plans" ? <PlansTab /> : tab === "codes" ? <CodesTab /> : tab === "payments" ? <PaymentsTab /> : <BrandingTab />}
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

function PaymentsTab() {
  const { data, reload } = useAsync(() => api<any[]>("/api/owner/payment-methods"), []);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("bank");
  const [logo, setLogo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      await api("/api/owner/payment-providers", { body: { name: name.trim(), kind, logo } });
      toast("تمت الإضافة — أضف حساباته الآن");
      setName("");
      setLogo(null);
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
      <div className="space-y-4">
        <Card title="إضافة بنك أو صرافة أو محفظة">
          <div className="space-y-3">
            <Field label="الاسم"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="مثل: بنك الكريمي" /></Field>
            <Field label="النوع">
              <div className="flex gap-2">
                {([["bank", "بنك"], ["exchange", "صرافة"], ["wallet", "محفظة"]] as const).map(([k, l]) => (
                  <button key={k} type="button" className={`flex-1 rounded-xl border px-3 py-2 text-sm font-bold ${kind === k ? "border-violet-500 bg-violet-500/10" : "border-[var(--border)]"}`} onClick={() => setKind(k)}>{l}</button>
                ))}
              </div>
            </Field>
            <Field label="الشعار (اختياري)"><LogoPicker value={logo} onChange={setLogo} /></Field>
            <button className="btn btn-primary w-full" disabled={busy || !name.trim()} onClick={add}>{busy ? "…" : "إضافة"}</button>
          </div>
        </Card>
        <Alert tone="info">تظهر هذه الحسابات للزوار في صفحة الباقات قبل التسجيل، مع زر «أرسل السند هنا» اللي يوديهم لرابط التواصل للشراء (من تبويب الباقات).</Alert>
      </div>
      <div className="space-y-4">
        {!data ? <Spinner /> : !data.length ? <Empty title="لا توجد بنوك أو صرافات أو محافظ بعد" /> : data.map((p, i) => <ProviderCard key={p.id} p={p} first={i === 0} last={i === data.length - 1} reload={reload} />)}
      </div>
    </div>
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
  const setPoint = (i: number, k: "title" | "desc", v: string) => setTexts({ ...t, points: t.points.map((p, j) => (j === i ? { ...p, [k]: v } : p)) });
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
            {t.points.map((p, i) => (
              <div key={i} className="grid gap-2 rounded-2xl border border-[var(--border)] p-3 sm:grid-cols-[1fr_1.4fr]">
                <input className="input" value={p.title} onChange={(e) => setPoint(i, "title", e.target.value)} maxLength={60} placeholder={`النقطة ${i + 1} — العنوان (فارغ = تختفي)`} aria-label={`النقطة ${i + 1}`} />
                <input className="input" value={p.desc} onChange={(e) => setPoint(i, "desc", e.target.value)} maxLength={120} placeholder="الوصف" aria-label={`وصف النقطة ${i + 1}`} />
              </div>
            ))}
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
