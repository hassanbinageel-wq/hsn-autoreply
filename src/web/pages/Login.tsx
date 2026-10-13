import { Icon } from "../components/Icon";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, setCsrf } from "../api";
import { API_BASE, deviceToken, isNative } from "../platform";
import { Alert, Field } from "../components/ui";
import { PlansShowcase, type Catalog } from "../components/PlansShowcase";
import { AppDownloadBox, DesktopBanner, MobileBanner, type Branding } from "../components/LoginBanner";
import { bioCredentials, bioUser, disableBio, offerBioLater } from "../lib/biometric";
import { Spinner } from "../components/ui";

export function LoginPage({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<{ needs_setup: boolean; setup_enabled: boolean; missing_secrets: string[] } | null>(null);
  const [show, setShow] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Self sign-up with an activation code (#/register); public plans page (#/plans).
  const [register, setRegister] = useState(() => location.hash.startsWith("#/register"));
  const [plans, setPlans] = useState(() => location.hash.startsWith("#/plans"));
  useEffect(() => {
    const on = () => {
      setPlans(location.hash.startsWith("#/plans"));
      setRegister(location.hash.startsWith("#/register"));
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");

  const [brand, setBrand] = useState<Branding | null>(null);
  useEffect(() => {
    api("/api/auth/status").then(setStatus, (e) => setError(e.message));
    api<Branding>("/api/public/branding").then(setBrand, () => undefined);
  }, []);

  const signIn = async (u: string, pw: string) => {
    const r = await api<{ token?: string; csrf_token?: string }>("/api/auth/login", {
      body: { username: u, password: pw, client: isNative ? "app" : "web", device_label: isNative ? "Android" : undefined },
    });
    if (isNative && r.token) await deviceToken.set(r.token);
    setCsrf(r.csrf_token);
  };

  // Fingerprint sign-in (Android app): offered automatically when this device has it switched on.
  const [bio, setBio] = useState<string | null>(() => bioUser());
  const fingerprint = async () => {
    setError(null);
    let creds: { username: string; password: string } | null = null;
    try {
      creds = await bioCredentials();
    } catch {
      return; // cancelled, or biometrics changed on the phone
    }
    if (!creds) return;
    setBusy(true);
    try {
      await signIn(creds.username, creds.password);
      onDone();
    } catch (err) {
      const e2 = err as ApiError;
      if (e2.status === 401 || e2.code === "invalid_credentials") {
        await disableBio();
        setBio(null);
        setError("كلمة المرور تغيّرت — سجّل دخولك بكلمة المرور مرة وحدة وفعّل البصمة من جديد.");
      } else setError(e2.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (bio && !register && !location.hash.startsWith("#/plans")) void fingerprint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      await signIn(username, password);
      // Sign-in is done here; fingerprint sign-in is offered afterwards in the app (never blocks this step).
      offerBioLater(username, password);
      setPassword("");
      onDone();
    } catch (err) {
      const e2 = err as ApiError;
      setError(e2.details?.map((d) => d.message).join("، ") || e2.message);
    } finally {
      setBusy(false);
    }
  };

  if (plans && !status?.needs_setup) return <PublicPlansPage />;
  // Not shown inside the Android app itself (it is already installed).
  const download = !isNative && brand?.app_download_url ? { url: brand.app_download_url, icon: brand.app_icon ?? null } : null;

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <MobileBanner className="lg:hidden" image={abs(brand?.login_banner_mobile ?? brand?.login_banner)} texts={brand?.texts ?? null} logo={brand?.logo ?? null} />
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
          {bio && !register && !status?.needs_setup && (
            <button type="button" onClick={fingerprint} disabled={busy} className="flex w-full items-center justify-center gap-2.5 rounded-2xl border-2 border-violet-500/40 bg-violet-500/5 py-3 font-bold text-violet-700 transition hover:bg-violet-500/10 dark:text-violet-300">
              <Icon name="fingerprint" size={22} />الدخول بالبصمة <span className="muted text-xs font-normal" dir="ltr">{bio}</span>
            </button>
          )}
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
                  <a href="#/plans" className="mr-2 inline-block rounded-lg bg-red-500/10 px-2.5 py-0.5 font-bold text-red-600 no-underline transition hover:bg-red-500/15 dark:text-red-400">الباقات</a>
                </>
              )}
            </p>
          )}
          <div className="flex items-start gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-3 text-xs text-[var(--text-2)]">
            <Icon name="shield" size={18} className="text-emerald-500" />
            <span>هذا حساب إدارة التطبيق فقط — لا نطلب كلمة مرور إنستقرام أبدًا. الربط يتم عبر Meta الرسمي.</span>
          </div>
          {download && <AppDownloadBox className="lg:hidden" tone="light" url={download.url} icon={download.icon} />}
          {register && !status?.needs_setup && (
            <a href="#/plans" className="flex items-center gap-3 rounded-2xl border border-red-500/25 bg-red-500/[0.06] p-3.5 transition hover:bg-red-500/10">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-500/10 text-red-600 dark:text-red-400"><Icon name="zap" size={20} /></span>
              <span className="flex-1 leading-tight"><b className="block text-sm">ما عندك كود؟</b><span className="muted text-xs">شوف الباقات والأسعار وطرق الدفع</span></span>
              <Icon name="arrowL" size={18} className="text-red-600 dark:text-red-400" />
            </a>
          )}
          <p className="muted text-center text-[11px] leading-relaxed">
            خدمة تقدّمها شركة ارقام المستديرة للدعاية والاعلان — الرقم الوطني الموحد 7042872536
            <br />
            <a className="underline" href={`${API_BASE || ""}/privacy`} target="_blank" rel="noopener">الخصوصية</a> · <a className="underline" href={`${API_BASE || ""}/terms`} target="_blank" rel="noopener">الشروط</a>
          </p>
        </form>
      </div>
      <DesktopBanner className="hidden w-[44%] max-w-[640px] lg:flex" image={abs(brand?.login_banner)} texts={brand?.texts ?? null} logo={brand?.logo ?? null} download={download} />
    </div>
  );
}


const abs = (path: string | null | undefined) => (path ? `${API_BASE || ""}${path}` : null);

/** Public plans page for visitors (#/plans): plans, prices in four currencies, payment accounts, "send the receipt". */
function PublicPlansPage() {
  const [data, setData] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Catalog>("/api/public/plans").then(setData, (e) => setError(e.message));
    window.scrollTo(0, 0);
  }, []);
  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface)]/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <a href="#/" className="flex items-center gap-2.5">
            <span className="grad flex h-9 w-9 items-center justify-center rounded-xl text-white"><Icon name="zap" size={18} /></span>
            <b className="font-display">HSN AutoReply</b>
          </a>
          <div className="flex gap-2">
            <a href="#/" className="btn btn-ghost min-h-9 text-xs">تسجيل الدخول</a>
            <a href="#/register" className="btn btn-primary min-h-9 text-xs">عندي كود</a>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-8 px-4 py-8">
        <div className="text-center">
          <span className="inline-block rounded-full bg-red-500/10 px-3 py-1 text-xs font-bold text-red-600 dark:text-red-400">الباقات</span>
          <h1 className="font-display mt-3 text-[28px] font-extrabold leading-tight sm:text-4xl">اختر الباقة المناسبة لحسابك</h1>
          <p className="muted mx-auto mt-2 max-w-xl text-sm leading-relaxed">ردود تلقائية على تعليقات وستوري إنستقرام عبر واجهة Meta الرسمية — بدون كلمة مرور، وبدون أي أدوات غير رسمية.</p>
        </div>
        {error ? <p className="text-center text-red-600">{error}</p> : !data ? <Spinner /> : <PlansShowcase catalog={data} />}
        <p className="muted text-center text-[11px] leading-relaxed">
          خدمة تقدّمها شركة ارقام المستديرة للدعاية والاعلان — الرقم الوطني الموحد 7042872536
          <br />
          <a className="underline" href={`${API_BASE || ""}/privacy`} target="_blank" rel="noopener">الخصوصية</a> · <a className="underline" href={`${API_BASE || ""}/terms`} target="_blank" rel="noopener">الشروط</a>
        </p>
      </main>
    </div>
  );
}
