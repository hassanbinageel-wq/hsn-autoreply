import { useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { Alert, Card, Empty, Field, Modal, Spinner, Tip, Toggle, fmtTime, toast, useAsync } from "../components/ui";
import { CURRENCIES, EVENT_LABELS, FEATURE_HINTS, FEATURE_LABELS, LIMIT_HINTS, PRICE_PERIODS, formatPrice } from "../../shared/plans";

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
                    onChange={(v) => {
                      if (v && !confirm("السماح بشرط المتابعة الإلزامي لهذا الحساب؟ معيار Meta للسبام يمنعه، وهو مخصص لحساباتك أنت فقط.")) return;
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
                  onClick={() => {
                    const pw = generatePassword();
                    if (!confirm(`تعيين كلمة مرور جديدة لـ «${t.name}»؟ سيتم تسجيل خروجه من كل الأجهزة.`)) return;
                    act(() => api(`/api/owner/tenants/${t.id}/password`, { body: { password: pw } }).then(() => prompt("كلمة المرور الجديدة (انسخها وأرسلها للعميل):", pw)), "تم تعيين كلمة مرور جديدة");
                  }}
                >
                  <Icon name="lock" size={15} />كلمة مرور جديدة
                </button>
                {t.status === "active" ? (
                  <button className="btn btn-ghost min-h-9 text-xs text-red-600" onClick={() => confirm(`إيقاف «${t.name}»؟ يُسجَّل خروجه وتتوقف ردوده التلقائية (بياناته تبقى).`) && act(() => api(`/api/owner/tenants/${t.id}/status`, { body: { status: "suspended" } }), "تم إيقاف العميل")}>
                    إيقاف
                  </button>
                ) : (
                  <button className="btn btn-ghost min-h-9 text-xs" onClick={() => act(() => api(`/api/owner/tenants/${t.id}/status`, { body: { status: "active" } }), "تم تفعيل العميل")}>
                    تفعيل
                  </button>
                )}
                <button
                  className="btn btn-ghost min-h-9 text-xs text-red-600"
                  onClick={() => {
                    const typed = prompt(`حذف «${t.name}» نهائيًا مع كل بياناته (حملات، رسائل، سحوبات، سجلات) — لا يمكن التراجع.\nللتأكيد اكتب اسم العميل كما هو:`);
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
      <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-[var(--border)]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <div className="muted mt-1.5 flex justify-between text-[11px]">
        <span>{exp ? `${active ? "ينتهي" : "انتهى"} ${new Date(exp).toLocaleDateString("ar")}` : "اضغط لتعيين باقة"}</span>
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
  const preview = (d: number) => new Date((active ? t.plan_expires_at : now) + d * DAY).toLocaleDateString("ar");
  return (
    <Modal open onClose={onClose} title={`اشتراك «${t.name}»`}>
      <div className="space-y-4">
        <div className="rounded-2xl bg-[var(--surface-2)] p-3 text-sm">
          {t.plan_expires_at ? (
            <>الباقة الحالية: <b>{t.plan_name ?? "—"}</b> · {active ? `ينتهي ${new Date(t.plan_expires_at).toLocaleDateString("ar")} (باقي ${Math.ceil((t.plan_expires_at - now) / DAY)} يوم)` : "منتهي"}</>
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
              <button key={d} className="btn btn-ghost min-h-9 flex-1 text-xs" disabled={busy} onClick={() => confirm(`خصم ${d} يوم من اشتراك «${t.name}»؟`) && save({ plan_id: t.plan_id ?? planId, days: -d }, `تم خصم ${d} يوم`)}>−{d} يوم</button>
            ))}
          </div>
        )}
        <Field label="أو حدّد تاريخ انتهاء بالضبط">
          <div className="flex gap-2">
            <input className="input" type="date" dir="ltr" value={date} onChange={(e) => setDate(e.target.value)} />
            <button className="btn btn-ghost shrink-0" disabled={busy || !planId || !date} onClick={() => save({ plan_id: planId, expires_at: new Date(`${date}T23:59:59`).getTime() }, "تم تحديد تاريخ الانتهاء")}>حفظ التاريخ</button>
          </div>
        </Field>
        {active && <button className="btn btn-ghost w-full text-red-600" disabled={busy} onClick={() => confirm("إنهاء اشتراك العميل الآن؟ تتوقف ردوده التلقائية.") && save({ plan_id: t.plan_id, expires_at: Date.now() }, "تم إنهاء الاشتراك")}>إنهاء الاشتراك الآن</button>}
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
                        <button className="btn btn-ghost min-h-8 px-2 text-xs" onClick={() => confirm("إلغاء هذا الكود؟ لن يمكن استخدامه.") && api(`/api/owner/codes/${c.id}/revoke`, { body: {} }).then(() => { toast("أُلغي"); reload(); }, (e) => toast(e.message, "bad"))}>إلغاء</button>
                      )}
                      <button className="btn btn-ghost min-h-8 px-2 text-xs text-red-600" aria-label="حذف الكود" onClick={() => confirm(state === "used" ? "حذف الكود من القائمة؟ اشتراك العميل يبقى كما هو." : "حذف الكود نهائيًا؟") && api(`/api/owner/codes/${c.id}`, { method: "DELETE" }).then(() => { toast("حُذف"); reload(); }, (e) => toast(e.message, "bad"))}>
                        <Icon name="x" size={14} />حذف
                      </button>
                    </span>
                  </div>
                  <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                    <div className="flex gap-1.5"><dt className="muted">أُنشئ:</dt><dd>{fmtTime(c.created_at)}</dd></div>
                    {c.note && <div className="flex gap-1.5"><dt className="muted">ملاحظة:</dt><dd>{c.note}</dd></div>}
                    {state === "used" && (
                      <>
                        <div className="flex gap-1.5"><dt className="muted">استخدمه:</dt><dd><b>{c.used_by ?? "—"}</b>{c.used_by_username && <span className="muted" dir="ltr"> @{c.used_by_username}</span>}{!c.customer_exists && <span className="text-red-600"> (محذوف)</span>}</dd></div>
                        <div className="flex gap-1.5"><dt className="muted">وقت التفعيل:</dt><dd>{fmtTime(c.used_at)}</dd></div>
                        {c.customer_exists && c.customer_expires_at ? <div className="flex gap-1.5"><dt className="muted">اشتراكه الحالي حتى:</dt><dd>{new Date(c.customer_expires_at).toLocaleDateString("ar")}</dd></div> : null}
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
      <div className="grid gap-5 xl:grid-cols-3">
        {data.map((p) => <PlanEditor key={p.id} plan={p} onSaved={reload} />)}
      </div>
    </div>
  );
}

function PlanEditor({ plan, onSaved }: { plan: any; onSaved: () => void }) {
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
          <div className="grid grid-cols-[1fr_auto_auto] gap-2">
            <input className="input" type="number" min={0} step="any" dir="ltr" value={f.price_amount ?? ""} onChange={(e) => setF({ ...f, price_amount: e.target.value })} placeholder="99" aria-label="المبلغ" />
            <select className="input !w-auto" value={f.price_currency || "SAR"} onChange={(e) => setF({ ...f, price_currency: e.target.value })} aria-label="العملة">
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
            <select className="input !w-auto" value={f.price_period || "month"} onChange={(e) => setF({ ...f, price_period: e.target.value })} aria-label="المدة">
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
          {Object.entries(FEATURE_LABELS).map(([k, label]) => <Toggle key={k} checked={!!f.limits[k]} onChange={(v) => setL(k, v)} label={<Tip text={FEATURE_HINTS[k]}>{label}</Tip>} />)}
          <Toggle checked={!!f.active} onChange={(v) => setF({ ...f, active: v })} label="معروضة للعملاء" description="تظهر في صفحة الأسعار وصفحة «اشتراكي». إخفاؤها لا يوقف المشتركين الحاليين فيها، وتقدر تولّد لها أكواد." />
        </div>
        <button className="btn btn-primary w-full" disabled={busy} onClick={save}>{busy ? "…" : "حفظ الباقة"}</button>
      </div>
    </Card>
  );
}

export function OwnerPage() {
  const [tab, setTab] = useState<"customers" | "plans" | "codes" | "payments">("customers");
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-extrabold leading-tight sm:text-[26px]">العملاء والاشتراكات</h1>
        <p className="muted mt-1 text-sm">العملاء، الباقات، وأكواد التفعيل — لإدارة الخدمة فقط.</p>
      </header>
      <div className="seg w-fit max-w-full overflow-x-auto" role="tablist">
        {([["customers", "العملاء"], ["plans", "الباقات"], ["codes", "أكواد التفعيل"], ["payments", "الحسابات البنكية"]] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === "customers" ? <CustomersTab /> : tab === "plans" ? <PlansTab /> : tab === "codes" ? <CodesTab /> : <PaymentsTab />}
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
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("تعذّر قراءة الصورة"));
      i.src = url;
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
  } finally {
    URL.revokeObjectURL(url);
  }
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
          <span className="chip surface-2 muted text-[11px]">{p.kind === "exchange" ? "صرافة" : "بنك"}</span>
        </span>
      }
      action={
        <span className="flex gap-1">
          <button className="btn btn-ghost min-h-8 px-2 text-xs" disabled={first} aria-label="تحريك لأعلى" onClick={() => call(() => api(`/api/owner/payment-providers/${p.id}/move`, { body: { dir: "up" } }), "تم")}>↑</button>
          <button className="btn btn-ghost min-h-8 px-2 text-xs" disabled={last} aria-label="تحريك لأسفل" onClick={() => call(() => api(`/api/owner/payment-providers/${p.id}/move`, { body: { dir: "down" } }), "تم")}>↓</button>
          <button className="btn btn-ghost min-h-8 px-2 text-xs" onClick={() => setEdit(!edit)}>تعديل</button>
          <button className="btn btn-ghost min-h-8 px-2 text-xs text-red-600" onClick={() => confirm(`حذف «${p.name}» مع كل حساباته؟`) && call(() => api(`/api/owner/payment-providers/${p.id}`, { method: "DELETE" }), "تم الحذف")}>حذف</button>
        </span>
      }
    >
      {edit && (
        <div className="mb-4 space-y-3 rounded-2xl bg-[var(--surface-2)] p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="الاسم" />
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="النوع"><option value="bank">بنك</option><option value="exchange">صرافة</option></select>
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
              <button className="btn btn-ghost min-h-8 px-2 text-xs text-red-600" onClick={() => confirm("حذف هذا الحساب؟") && call(() => api(`/api/owner/payment-accounts/${a.id}`, { method: "DELETE" }), "تم الحذف")}>حذف</button>
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
        <Card title="إضافة بنك أو صرافة">
          <div className="space-y-3">
            <Field label="الاسم"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="مثل: بنك الكريمي" /></Field>
            <Field label="النوع">
              <div className="flex gap-2">
                {([["bank", "بنك"], ["exchange", "صرافة"]] as const).map(([k, l]) => (
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
        {!data ? <Spinner /> : !data.length ? <Empty title="لا توجد بنوك أو صرافات بعد" /> : data.map((p, i) => <ProviderCard key={p.id} p={p} first={i === 0} last={i === data.length - 1} reload={reload} />)}
      </div>
    </div>
  );
}
