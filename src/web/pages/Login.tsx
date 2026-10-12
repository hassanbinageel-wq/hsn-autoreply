import { Icon } from "../components/Icon";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, setCsrf } from "../api";
import { API_BASE, deviceToken, isNative } from "../platform";
import { Alert, Field } from "../components/ui";

export function LoginPage({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<{ needs_setup: boolean; setup_enabled: boolean; missing_secrets: string[] } | null>(null);
  const [show, setShow] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Self sign-up with an activation code (#/register).
  const [register, setRegister] = useState(() => location.hash.startsWith("#/register"));
  const [name, setName] = useState("");
  const [code, setCode] = useState("");

  useEffect(() => {
    api("/api/auth/status").then(setStatus, (e) => setError(e.message));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (status?.needs_setup) {
        await api("/api/auth/setup", { body: { setup_token: setupToken, username, password } });
      } else if (register) {
        await api("/api/auth/register", { body: { name: name.trim(), username: username.trim(), password, code } });
        location.hash = "#/";
      }
      const r = await api<{ token?: string; csrf_token?: string }>("/api/auth/login", {
        body: { username, password, client: isNative ? "app" : "web", device_label: isNative ? "Android" : undefined },
      });
      if (isNative && r.token) await deviceToken.set(r.token);
      setCsrf(r.csrf_token);
      setPassword("");
      onDone();
    } catch (err) {
      const e2 = err as ApiError;
      setError(e2.details?.map((d) => d.message).join("، ") || e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen">
      <div className="flex flex-1 items-center justify-center p-5">
        <form onSubmit={submit} className="w-full max-w-[400px] space-y-4">
          <div className="mb-6 flex items-center gap-3">
            <span className="grad flex h-11 w-11 items-center justify-center rounded-xl text-white shadow-lg shadow-violet-500/30"><Icon name="zap" size={22} /></span>
            <span className="leading-tight"><b className="font-display block text-lg font-extrabold">HSN AutoReply</b><span className="muted text-xs">لوحة الإدارة</span></span>
          </div>
          <div>
            <h1 className="text-[28px] font-extrabold leading-tight">{status?.needs_setup ? "إعداد حساب الإدارة" : register ? "أنشئ حسابك ✨" : "أهلًا بعودتك 👋"}</h1>
            <p className="muted mt-1.5 text-sm">
              {status?.needs_setup ? "الإعداد الأولي لحساب الإدارة (مرة واحدة)" : register ? "عندك كود تفعيل؟ أنشئ حسابك وابدأ مباشرة." : "سجّل دخولك لإدارة حملاتك ورسائلك وسحوباتك."}
            </p>
          </div>
          {isNative && !API_BASE && <Alert tone="bad">لم يُحدَّد عنوان الخادم في هذا الإصدار (VITE_API_BASE).</Alert>}
          {status?.missing_secrets?.length ? <Alert tone="warn">أسرار الخادم غير مكتملة: {status.missing_secrets.join(", ")}</Alert> : null}
          {status?.needs_setup && !status.setup_enabled && (
            <Alert tone="warn">الإعداد الأولي معطّل. أضف السر SETUP_TOKEN و PASSWORD_PEPPER إلى Worker ثم أعد المحاولة (انظر docs/DEPLOY.md).</Alert>
          )}
          {status?.needs_setup && (
            <Field label="رمز الإعداد (SETUP_TOKEN)" hint="القيمة التي وضعتها كسر في Cloudflare. لا تشاركها مع أحد.">
              <input className="input" type="password" autoComplete="off" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} required />
            </Field>
          )}
          {register && !status?.needs_setup && (
            <>
              <Field label="كود التفعيل" hint="يصلك بعد الاشتراك، مثل: HSN-XXXX-XXXX-XXXX">
                <input className="input" dir="ltr" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="HSN-XXXX-XXXX-XXXX" required />
              </Field>
              <Field label="اسمك أو اسم متجرك">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
              </Field>
            </>
          )}
          <Field label="اسم المستخدم" hint={register && !status?.needs_setup ? "أحرف إنجليزية وأرقام فقط" : undefined}>
            <input className="input" dir="ltr" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </Field>
          <Field label="كلمة المرور" hint={status?.needs_setup || register ? "12 حرفًا على الأقل" : undefined}>
            <div className="relative">
              <input className="input pl-11" dir="ltr" type={show ? "text" : "password"} autoComplete={status?.needs_setup || register ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button type="button" onClick={() => setShow((v) => !v)} className="muted absolute left-3 top-1/2 -translate-y-1/2" aria-label={show ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}><Icon name="eye" size={18} /></button>
            </div>
          </Field>
          {error && <Alert tone="bad">{error}</Alert>}
          <button type="submit" className="btn btn-primary min-h-12 w-full text-[15px]" disabled={busy || !status}>
            {busy ? "…" : status?.needs_setup ? "إنشاء حساب الإدارة والدخول" : register ? "إنشاء الحساب والدخول" : "تسجيل الدخول"}
          </button>
          {!status?.needs_setup && (
            <p className="text-center text-sm">
              {register ? (
                <button type="button" className="font-semibold text-violet-600 underline dark:text-violet-300" onClick={() => { setRegister(false); setError(null); location.hash = "#/"; }}>عندي حساب — تسجيل الدخول</button>
              ) : (
                <>
                  <button type="button" className="font-semibold text-violet-600 underline dark:text-violet-300" onClick={() => { setRegister(true); setError(null); location.hash = "#/register"; }}>عندك كود تفعيل؟ أنشئ حسابك</button>
                  <span className="muted"> · </span>
                  <a className="muted underline" href={`${API_BASE || ""}/pricing`} target="_blank" rel="noopener">الباقات</a>
                </>
              )}
            </p>
          )}
          <div className="flex items-start gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-3 text-xs text-[var(--text-2)]">
            <Icon name="shield" size={18} className="text-emerald-500" />
            <span>هذا حساب إدارة التطبيق فقط — لا نطلب كلمة مرور إنستقرام أبدًا. الربط يتم عبر Meta الرسمي.</span>
          </div>
        </form>
      </div>
      <div className="relative hidden w-[44%] max-w-[640px] flex-col overflow-hidden p-12 text-white lg:flex" style={{ background: "radial-gradient(circle at 80% 15%,rgba(249,115,22,.55),transparent 45%),radial-gradient(circle at 15% 85%,rgba(219,39,119,.5),transparent 50%),linear-gradient(160deg,#1e0b4b,#4c1d95 50%,#86198f)" }}>
        <div className="absolute inset-0" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px)", backgroundSize: "48px 48px" }} />
        <div className="relative">
          <h2 className="text-[36px] font-extrabold leading-snug">ردود تلقائية أذكى<br />وتفاعل أكبر على إنستقرام</h2>
          <p className="mt-3 max-w-md leading-loose text-violet-100">حملات تعليقات وستوري، صندوق رسائل موحّد، سحوبات عادلة وبطاقات تهنئة — كلها عبر واجهة Meta الرسمية.</p>
        </div>
        <div className="relative mt-auto grid gap-3">
          {[
            ["target", "حملات تعليقات وستوري", "ترد تلقائيًا وتوصل المحتوى كزر يُفتح دائمًا"],
            ["gift", "سحوبات عادلة", "اختيار آمن على الخادم مع عرض احتفالي وفيديو"],
            ["shield", "Meta الرسمي فقط", "بدون كلمة مرور، وبدون أي طرق غير رسمية"],
          ].map(([i, t, d]) => (
            <div key={t} className="flex items-center gap-3 rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15"><Icon name={i} size={20} /></span>
              <span><b className="block text-sm">{t}</b><span className="text-xs text-violet-100">{d}</span></span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
