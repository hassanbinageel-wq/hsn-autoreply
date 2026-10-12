import { useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { Alert, Card, Empty, Field, Modal, Spinner, Toggle, fmtTime, toast, useAsync } from "../components/ui";
import { EVENT_LABELS, FEATURE_LABELS } from "../../shared/plans";

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
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <span className={`chip ${t.plan_expires_at > Date.now() ? "bg-violet-500/10 text-violet-700 dark:text-violet-200" : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"}`}>
                  {t.plan_name ?? "بدون باقة"}{t.plan_expires_at ? ` · ${t.plan_expires_at > Date.now() ? `حتى ${new Date(t.plan_expires_at).toLocaleDateString("ar")}` : "منتهي"}` : ""}
                </span>
                <span className="muted">رسائل الشهر: {(t.messages_month ?? 0).toLocaleString("en-US")}</span>
              </div>
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

function SetPlan({ t, plans, onClose, onDone }: { t: any; plans: any[]; onClose: () => void; onDone: () => void }) {
  const [planId, setPlanId] = useState<string>(t.plan_id ?? plans[0]?.id ?? "");
  const [days, setDays] = useState(30);
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
  return (
    <Modal open onClose={onClose} title={`باقة «${t.name}»`}>
      <p className="muted mb-3 text-sm">للحالات اللي تستلم فيها الدفع مباشرة بدون كود. الأيام تُضاف بعد تاريخ الانتهاء الحالي إذا كان الاشتراك فعّالًا.</p>
      <div className="space-y-3">
        <Field label="الباقة">
          <select className="input" value={planId} onChange={(e) => setPlanId(e.target.value)}>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="المدة (أيام)">
          <div className="flex flex-wrap gap-2">
            {[30, 90, 180, 365].map((d) => (
              <button key={d} type="button" className={`rounded-xl border px-3 py-2 text-sm font-bold ${days === d ? "border-violet-500 bg-violet-500/10" : "border-[var(--border)]"}`} onClick={() => setDays(d)}>{d}</button>
            ))}
            <input className="input !w-24" type="number" min={1} value={days} onChange={(e) => setDays(Number(e.target.value))} />
          </div>
        </Field>
        <button className="btn btn-primary w-full" disabled={busy || !planId || days < 1} onClick={() => save({ plan_id: planId, days }, "تم تعيين الباقة")}>حفظ</button>
        {t.plan_id && <button className="btn btn-ghost w-full text-red-600" disabled={busy} onClick={() => confirm("إنهاء اشتراك العميل الآن؟") && save({ plan_id: t.plan_id, expires_at: Date.now() }, "تم إنهاء الاشتراك")}>إنهاء الاشتراك الآن</button>}
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
      <Card title="الأكواد">
        {!data ? <Spinner /> : !data.length ? <Empty title="لا توجد أكواد بعد" /> : (
          <ul className="divide-y divide-[var(--border)] text-sm">
            {data.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <span className="font-mono" dir="ltr">…{c.hint}</span>
                <span className="chip bg-violet-500/10 text-violet-700 dark:text-violet-200">{c.plan_name ?? planName(c.plan_id)} · {c.days} يوم</span>
                <span className="muted text-xs">{c.note}</span>
                <span className="mr-auto text-xs">
                  {c.used_at ? <span className="text-emerald-600">استُخدم — {c.used_by ?? "عميل محذوف"} · {fmtTime(c.used_at)}</span> : c.revoked_at ? <span className="text-red-600">ملغى</span> : <span className="muted">غير مستخدم · {fmtTime(c.created_at)}</span>}
                </span>
                {!c.used_at && !c.revoked_at && (
                  <button className="btn btn-ghost min-h-8 px-2 text-xs text-red-600" onClick={() => confirm("إلغاء هذا الكود؟") && api(`/api/owner/codes/${c.id}/revoke`, { body: {} }).then(() => { toast("أُلغي"); reload(); }, (e) => toast(e.message, "bad"))}>إلغاء</button>
                )}
              </li>
            ))}
          </ul>
        )}
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
  const { data: settings, reload: reloadSettings } = useAsync(() => api<{ sales_contact: string }>("/api/owner/settings"), []);
  const [contact, setContact] = useState<string | null>(null);
  if (!data || !settings) return <Spinner />;
  const saveContact = async () => {
    try {
      await api("/api/owner/settings", { method: "PUT", body: { sales_contact: (contact ?? settings.sales_contact).trim() } });
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
            <button className="btn btn-primary shrink-0" onClick={saveContact}>حفظ</button>
          </div>
        </Field>
      </Card>
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
      await api(`/api/owner/plans/${plan.id}`, { method: "PUT", body: { name: f.name, price_label: f.price_label || undefined, description: f.description || undefined, active: !!f.active, limits: f.limits } });
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
        <Field label="السعر (كما يظهر)" hint="مثل: 99 ر.س / شهريًا"><input className="input" value={f.price_label ?? ""} onChange={(e) => setF({ ...f, price_label: e.target.value })} maxLength={60} /></Field>
        <Field label="وصف قصير"><input className="input" value={f.description ?? ""} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={200} /></Field>
        {LIMIT_FIELDS.map(([k, label]) => (
          <Field key={k} label={label} hint="فارغ = غير محدود">
            <input className="input" type="number" min={0} value={f.limits[k] ?? ""} onChange={(e) => setL(k, e.target.value === "" ? null : Number(e.target.value))} />
          </Field>
        ))}
        <div>
          <div className="font-display mb-1.5 text-[13px] font-bold text-[var(--text-2)]">الأحداث</div>
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
          {Object.entries(FEATURE_LABELS).map(([k, label]) => <Toggle key={k} checked={!!f.limits[k]} onChange={(v) => setL(k, v)} label={label} />)}
          <Toggle checked={!!f.active} onChange={(v) => setF({ ...f, active: v })} label="ظاهرة في صفحة الباقات" />
        </div>
        <button className="btn btn-primary w-full" disabled={busy} onClick={save}>{busy ? "…" : "حفظ الباقة"}</button>
      </div>
    </Card>
  );
}

export function OwnerPage() {
  const [tab, setTab] = useState<"customers" | "plans" | "codes">("customers");
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-extrabold leading-tight sm:text-[26px]">العملاء والاشتراكات</h1>
        <p className="muted mt-1 text-sm">العملاء، الباقات، وأكواد التفعيل — لإدارة الخدمة فقط.</p>
      </header>
      <div className="seg w-fit max-w-full overflow-x-auto" role="tablist">
        {([["customers", "العملاء"], ["plans", "الباقات"], ["codes", "أكواد التفعيل"]] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === "customers" ? <CustomersTab /> : tab === "plans" ? <PlansTab /> : <CodesTab />}
    </div>
  );
}
