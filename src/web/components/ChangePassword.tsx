import { useState } from "react";
import { api } from "../api";
import { Icon } from "./Icon";
import { Alert, Card, Field, toast } from "./ui";

/** Settings ← الأمان: change the password — current one, the new one, then the code emailed to the confirmed address. */
export function ChangePasswordCard() {
  const [current, setCurrent] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [show, setShow] = useState(false);
  const [step, setStep] = useState<"form" | "code">("form");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [needEmail, setNeedEmail] = useState(false);
  const start = async () => {
    if (pw !== pw2) return toast("كلمتا المرور الجديدتان غير متطابقتين", "bad");
    setBusy(true);
    setNeedEmail(false);
    try {
      await api("/api/account/password", { body: { current, password: pw } });
      setStep("code");
      setCode("");
      toast("أرسلنا رمز التأكيد لإيميلك 📬");
    } catch (e: any) {
      if (e.code === "need_email") setNeedEmail(true);
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    setBusy(true);
    try {
      await api("/api/account/password/confirm", { body: { code } });
      toast("تم تغيير كلمة المرور ✅ — طلعناك من الأجهزة الثانية");
      setStep("form");
      setCurrent("");
      setPw("");
      setPw2("");
    } catch (e: any) {
      toast(e.message, "bad");
      if (e.code === "expired") setStep("form");
    } finally {
      setBusy(false);
    }
  };
  const type = show ? "text" : "password";
  return (
    <Card title="🔑 تغيير كلمة المرور" className="h-full">
      {step === "form" ? (
        <div className="space-y-3">
          <Field label="كلمة المرور الحالية">
            <div className="relative">
              <input className="input pl-11" dir="ltr" type={type} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
              <button type="button" onClick={() => setShow((v) => !v)} className="muted absolute left-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg" aria-label={show ? "إخفاء" : "إظهار"}><Icon name="eye" size={18} /></button>
            </div>
          </Field>
          <Field label="كلمة المرور الجديدة" hint="12 حرفًا على الأقل"><input className="input" dir="ltr" type={type} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          <Field label="أعد كتابة الجديدة"><input className="input" dir="ltr" type={type} autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
          {needEmail && <Alert tone="warn">أضف إيميلك وأكّده أول من بطاقة «إيميل استرجاع الحساب» — التغيير يحتاج تأكيد عليه.</Alert>}
          <button className="btn btn-primary" disabled={busy || !current || pw.length < 12 || !pw2} onClick={start}>{busy ? "…" : "متابعة — أرسل رمز التأكيد"}</button>
          <p className="muted text-xs">للأمان: كلمة المرور ما تتغير إلا بعد ما تكتب الرمز اللي يوصل إيميلك المؤكَّد.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <Alert tone="info">أرسلنا رمز من 6 أرقام لإيميلك. اكتبه هنا لإكمال التغيير (صالح 15 دقيقة).</Alert>
          <Field label="رمز التأكيد">
            <input className="input text-center text-lg tracking-[0.3em]" dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, ""))} placeholder="123456" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={busy || code.length !== 6} onClick={confirm}>{busy ? "…" : "تأكيد وتغيير"}</button>
            <button className="btn btn-ghost" onClick={() => setStep("form")}>رجوع</button>
          </div>
        </div>
      )}
    </Card>
  );
}
