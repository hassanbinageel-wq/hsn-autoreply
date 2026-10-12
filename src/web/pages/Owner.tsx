import { useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { Alert, Card, Empty, Field, Modal, Spinner, Toggle, fmtTime, toast, useAsync } from "../components/ui";

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

export function OwnerPage() {
  const { data, loading, error, reload } = useAsync(() => api<any[]>("/api/owner/tenants"), []);
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
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold leading-tight sm:text-[26px]">العملاء</h1>
          <p className="muted mt-1 text-sm">{data ? `${customers.length} عميل · ${customers.filter((t) => t.status === "active").length} نشط` : "إدارة حسابات العملاء"}</p>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={18} />عميل جديد</button>
      </header>
      <Alert tone="info">
        كل عميل له دخوله الخاص، ويربط حساب إنستقرام بنفسه عبر Meta الرسمي، وبياناته معزولة تمامًا عن غيره. الاشتراكات وأكواد التفعيل والباقات تجي في الدفعة القادمة.
      </Alert>
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
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
