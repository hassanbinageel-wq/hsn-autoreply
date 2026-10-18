import { useState } from "react";
import { api } from "../api";
import { Alert, Card, Field, toast, useAsync } from "./ui";

/** Settings card: the account email used only for password recovery — add/change it, confirm with the emailed code. */
export function AccountEmailCard() {
  const { data, reload } = useAsync(() => api<{ email: string | null; verified: boolean; enabled: boolean }>("/api/account/email"), []);
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const send = async (to: string) => {
    setBusy(true);
    try {
      await api("/api/account/email", { body: { email: to } });
      setSent(true);
      setCode("");
      toast("أرسلنا رمز تأكيد لإيميلك 📬");
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    setBusy(true);
    try {
      await api("/api/account/email/verify", { body: { code } });
      toast("تم تأكيد الإيميل ✅");
      setSent(false);
      setEditing(false);
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const pending = !!data.email && !data.verified;
  return (
    <Card title="📧 إيميل استرجاع الحساب" className="h-full">
      <div className="space-y-3 text-sm">
        {!data.enabled && <Alert tone="info">إرسال الإيميلات بيتفعّل قريب — تقدر تحفظ إيميلك بعدها.</Alert>}
        {data.verified && !editing ? (
          <>
            <Alert tone="good">إيميلك مؤكَّد ✅ <b dir="ltr">{data.email}</b> — إذا نسيت كلمة المرور، اضغط «نسيت كلمة المرور؟» في صفحة الدخول.</Alert>
            <button className="btn btn-ghost text-sm" onClick={() => { setEditing(true); setEmail(""); setSent(false); }}>تغيير الإيميل</button>
          </>
        ) : (
          <>
            {!data.email && !editing && <p className="muted">أضف إيميلك عشان تقدر تسترجع حسابك لو نسيت كلمة المرور. ما نرسل عليه إعلانات.</p>}
            {pending && !editing && !sent && (
              <Alert tone="warn">الإيميل <b dir="ltr">{data.email}</b> ما تأكد بعد — بدون تأكيد ما يوصلك رابط الاسترجاع.</Alert>
            )}
            {(sent || (pending && !editing)) ? (
              <div className="space-y-2">
                <Field label={`الرمز اللي وصلك على ${data.email ?? "إيميلك"}`}>
                  <input className="input text-center text-lg tracking-[0.3em]" dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, ""))} placeholder="123456" />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <button className="btn btn-primary" disabled={busy || code.length !== 6} onClick={verify}>{busy ? "…" : "تأكيد"}</button>
                  <button className="btn btn-ghost" disabled={busy || !data.enabled} onClick={() => send(data.email!)}>إعادة إرسال الرمز</button>
                  <button className="btn btn-ghost" onClick={() => { setEditing(true); setSent(false); setEmail(""); }}>إيميل آخر</button>
                </div>
                <p className="muted text-xs">ما وصلك؟ شيّك على البريد غير المرغوب (Spam). الرمز صالح 15 دقيقة.</p>
              </div>
            ) : (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="الإيميل">
                  <input className="input" dir="ltr" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" maxLength={254} />
                </Field>
                <button className="btn btn-primary" disabled={busy || !data.enabled || !/^\S+@\S+\.\S+$/.test(email)} onClick={() => send(email)}>{busy ? "…" : "إرسال رمز التأكيد"}</button>
                {editing && <button className="btn btn-ghost" onClick={() => setEditing(false)}>إلغاء</button>}
                {email.trim() && !/^\S+@\S+\.\S+$/.test(email) && <p className="w-full text-xs text-red-600">الإيميل ناقص — تأكد من «@» ومن النقطة، مثل: name@gmail.com</p>}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
