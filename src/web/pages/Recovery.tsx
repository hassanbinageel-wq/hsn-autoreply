import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { Icon } from "../components/Icon";
import { Alert, Field } from "../components/ui";

/** «Forgot password» (#/forgot) and the page the emailed link opens (#/reset?token=…). Shown before sign-in. */
export function RecoveryPage({ mode }: { mode: "forgot" | "reset" }) {
  return (
    <div className="flex min-h-screen items-start justify-center p-5 pt-16 sm:items-center sm:pt-5">
      <div className="w-full max-w-[400px] space-y-4">
        <div className="mb-6 flex items-center gap-3">
          <span className="grad flex h-11 w-11 items-center justify-center rounded-xl text-white shadow-lg shadow-violet-500/30"><Icon name="zap" size={22} /></span>
          <span className="leading-tight"><b className="font-display block text-lg font-extrabold">HSN AutoReply</b><span className="muted text-xs">استرجاع الحساب</span></span>
        </div>
        {mode === "forgot" ? <Forgot /> : <Reset />}
        <p className="text-center text-sm">
          <a href="#/" className="inline-flex min-h-10 items-center font-semibold text-violet-700 underline dark:text-violet-300">رجوع لتسجيل الدخول</a>
        </p>
      </div>
    </div>
  );
}

function Forgot() {
  const [login, setLogin] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ message: string }>("/api/auth/forgot", { body: { login } });
      setDone(r.message);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  if (done)
    return (
      <div className="space-y-3">
        <h1 className="text-[26px] font-extrabold">شيّك على إيميلك 📬</h1>
        <Alert tone="good">{done}</Alert>
        <p className="muted text-sm">الرابط يشتغل 30 دقيقة ومرة وحدة. ما وصلك شي؟ تأكد إن إيميلك مؤكَّد في الإعدادات، أو تواصل مع إدارة الخدمة.</p>
      </div>
    );
  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-[26px] font-extrabold">نسيت كلمة المرور؟</h1>
        <p className="muted mt-1.5 text-sm">اكتب اسم متجرك (اللي تدخل فيه) أو إيميلك، ونرسل لك رابط تعيّن فيه كلمة مرور جديدة.</p>
      </div>
      <Field label="اسم المتجر أو الإيميل">
        <input className="input" dir="ltr" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required minLength={2} />
      </Field>
      {error && <Alert tone="bad">{error}</Alert>}
      <button type="submit" className="btn btn-primary min-h-12 w-full" disabled={busy || login.trim().length < 2}>{busy ? "…" : "أرسل رابط الاسترجاع"}</button>
    </form>
  );
}

function Reset() {
  const token = new URLSearchParams(location.hash.split("?")[1] ?? "").get("token") ?? "";
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) return setError("كلمتا المرور غير متطابقتين");
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ username: string }>("/api/auth/reset", { body: { token, password: pw } });
      setDone(r.username);
    } catch (err) {
      const e2 = err as ApiError;
      setError(e2.details?.map((d) => d.message).join("، ") || e2.message);
    } finally {
      setBusy(false);
    }
  };
  if (!token) return <Alert tone="bad">الرابط ناقص — افتحه كامل من الإيميل، أو اطلب رابط جديد من «نسيت كلمة المرور».</Alert>;
  if (done)
    return (
      <div className="space-y-3">
        <h1 className="text-[26px] font-extrabold">تم تغيير كلمة المرور ✅</h1>
        <Alert tone="good">سجّلنا خروجك من كل الأجهزة. ادخل الحين باسم متجرك <b dir="ltr">{done}</b> وكلمة المرور الجديدة.</Alert>
        <a href="#/" className="btn btn-primary min-h-12 w-full">تسجيل الدخول</a>
      </div>
    );
  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-[26px] font-extrabold">كلمة مرور جديدة</h1>
        <p className="muted mt-1.5 text-sm">12 حرفًا على الأقل. بعد الحفظ يتسجّل خروجك من كل الأجهزة.</p>
      </div>
      <Field label="كلمة المرور الجديدة">
        <div className="relative">
          <input className="input pl-11" dir="ltr" type={show ? "text" : "password"} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={12} required />
          <button type="button" onClick={() => setShow((v) => !v)} className="muted absolute left-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg" aria-label={show ? "إخفاء" : "إظهار"}><Icon name="eye" size={18} /></button>
        </div>
      </Field>
      <Field label="أعد كتابتها">
        <input className="input" dir="ltr" type={show ? "text" : "password"} autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} minLength={12} required />
      </Field>
      {error && <Alert tone="bad">{error}</Alert>}
      <button type="submit" className="btn btn-primary min-h-12 w-full" disabled={busy || pw.length < 12}>{busy ? "…" : "حفظ كلمة المرور"}</button>
    </form>
  );
}
