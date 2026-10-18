import { useState } from "react";
import { api } from "../api";
import { askConfirm, showCopy } from "./Confirm";
import { Alert, Card, Field, Modal, toast, useAsync } from "./ui";

/**
 * Settings card (owner): two-step login with an authenticator app (Google Authenticator, Microsoft
 * Authenticator…). Scan the QR, confirm one code, keep the recovery codes.
 */
export function TwoFactorCard() {
  const { data, reload } = useAsync(() => api<{ available: boolean; enabled: boolean; enabled_at: number | null; recovery_left: number }>("/api/auth/totp"), []);
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [off, setOff] = useState(false);
  if (!data?.available) return null;
  const start = async () => {
    try {
      const r = await api<{ secret: string; uri: string }>("/api/auth/totp/setup", { body: {} });
      const { default: qrcode } = await import("qrcode-generator");
      const q = qrcode(0, "M");
      q.addData(r.uri);
      q.make();
      setSetup({ ...r, qr: q.createDataURL(5, 2) });
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  return (
    <Card title="🔐 التحقق بخطوتين" className="h-full">
      {data.enabled ? (
        <div className="space-y-3">
          <Alert tone="good">مفعّل ✅ — الدخول لحسابك يحتاج كلمة المرور + الرمز من تطبيق المصادقة.</Alert>
          <p className="muted text-sm">رموز الاسترداد المتبقية: <b className="text-[var(--text)]">{data.recovery_left}</b> من 8{data.recovery_left <= 2 ? " — قليلة، أوقف التحقق وفعّله من جديد عشان تاخذ رموز جديدة." : ""}</p>
          <button className="btn btn-ghost text-sm text-red-600" onClick={() => setOff(true)}>إيقاف التحقق بخطوتين</button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="muted text-sm">لو أحد عرف كلمة مرورك، ما يقدر يدخل لوحتك بدون الرمز اللي يطلع في جوالك. تحتاج تطبيق مثل <b>Google Authenticator</b> أو <b>Microsoft Authenticator</b> (مجاني).</p>
          <button className="btn btn-primary" onClick={start}>تفعيل التحقق بخطوتين</button>
        </div>
      )}
      {setup && <SetupModal setup={setup} onClose={() => setSetup(null)} onDone={() => { setSetup(null); reload(); }} />}
      {off && <DisableModal onClose={() => setOff(false)} onDone={() => { setOff(false); reload(); }} />}
    </Card>
  );
}

function SetupModal({ setup, onClose, onDone }: { setup: { secret: string; uri: string; qr: string }; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      const r = await api<{ recovery_codes: string[] }>("/api/auth/totp/enable", { body: { code } });
      await showCopy({
        title: "احفظ رموز الاسترداد الحين",
        message: "إذا ضاع جوالك أو حذفت التطبيق، تدخل بواحد من هذي الرموز بدل الرمز (كل رمز يُستخدم مرة وحدة). احفظها في مكان آمن غير الإيميل — ما راح تظهر مرة ثانية.",
        text: r.recovery_codes.join("\n"),
      });
      toast("تم تفعيل التحقق بخطوتين 🔐");
      onDone();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const close = async () => {
    if (await askConfirm({ title: "إلغاء التفعيل؟", message: "التحقق بخطوتين ما راح يتفعّل لين تكمل الخطوات.", confirmLabel: "إلغاء" })) onClose();
  };
  return (
    <Modal open onClose={close} title="تفعيل التحقق بخطوتين" center>
      <div className="space-y-3 text-sm">
        <ol className="list-decimal space-y-1 ps-5">
          <li>افتح تطبيق المصادقة في جوالك واضغط <b>+</b> ← <b>مسح رمز QR</b>.</li>
          <li>امسح الرمز هذا (أو أدخل المفتاح يدويًا).</li>
          <li>اكتب الرمز المكوّن من 6 أرقام اللي يطلع في التطبيق.</li>
        </ol>
        <div className="flex justify-center"><img src={setup.qr} alt="رمز QR للتحقق بخطوتين" className="rounded-xl bg-white p-2" width={220} height={220} /></div>
        <div className="text-center">
          <div className="muted text-xs">المفتاح اليدوي:</div>
          <code className="select-all break-all text-xs font-bold" dir="ltr">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
          <div><a className="text-xs font-semibold text-violet-600 underline dark:text-violet-300" href={setup.uri}>من الجوال؟ اضغط هنا لفتح التطبيق مباشرة</a></div>
        </div>
        <Field label="الرمز من التطبيق">
          <input className="input text-center text-lg tracking-[0.3em]" dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))} placeholder="123456" />
        </Field>
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={close}>إلغاء</button>
          <button className="btn btn-primary" disabled={busy || code.replace(/\D/g, "").length !== 6} onClick={confirm}>{busy ? "…" : "تأكيد وتفعيل"}</button>
        </div>
      </div>
    </Modal>
  );
}

function DisableModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await api("/api/auth/totp/disable", { body: { password, code } });
      toast("تم إيقاف التحقق بخطوتين");
      onDone();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="إيقاف التحقق بخطوتين" center>
      <div className="space-y-3">
        <Alert tone="warn">بعد الإيقاف، كلمة المرور وحدها تكفي للدخول.</Alert>
        <Field label="كلمة المرور"><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Field label="الرمز من التطبيق (أو رمز استرداد)"><input className="input" dir="ltr" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>إلغاء</button>
          <button className="btn btn-primary" disabled={busy || !password || code.trim().length < 6} onClick={go}>{busy ? "…" : "إيقاف"}</button>
        </div>
      </div>
    </Modal>
  );
}
