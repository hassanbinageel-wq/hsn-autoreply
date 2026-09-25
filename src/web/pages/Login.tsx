import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, setCsrf } from "../api";
import { API_BASE, deviceToken, isNative } from "../platform";
import { Alert, Field } from "../components/ui";

export function LoginPage({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<{ needs_setup: boolean; setup_enabled: boolean; missing_secrets: string[] } | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-md space-y-4 p-6">
        <div className="text-center">
          <img src="./favicon.svg" alt="" className="mx-auto h-14 w-14" />
          <h1 className="mt-2 text-2xl font-bold">HSN AutoReply</h1>
          <p className="muted text-sm">{status?.needs_setup ? "الإعداد الأولي لحساب الإدارة (مرة واحدة)" : "تسجيل الدخول للوحة التحكم"}</p>
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
        <Field label="اسم المستخدم">
          <input className="input" dir="ltr" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </Field>
        <Field label="كلمة المرور" hint={status?.needs_setup ? "12 حرفًا على الأقل" : undefined}>
          <input className="input" dir="ltr" type="password" autoComplete={status?.needs_setup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {error && <Alert tone="bad">{error}</Alert>}
        <button className="btn btn-primary w-full" disabled={busy || !status}>
          {busy ? "…" : status?.needs_setup ? "إنشاء حساب الإدارة والدخول" : "دخول"}
        </button>
        <p className="muted text-center text-xs">هذا حساب إدارة التطبيق فقط — لا نطلب كلمة مرور إنستقرام أبدًا.</p>
      </form>
    </div>
  );
}
