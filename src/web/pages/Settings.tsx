import { useEffect, useState } from "react";
import { api, download } from "../api";
import { APP_VERSION, isNative } from "../platform";
import { Link } from "../App";
import { Alert, Card, Field, PageHeader, Spinner, Toggle, setTz, toast, useAsync } from "../components/ui";

export function SettingsPage({ theme, setTheme, onLogout, username }: { theme: string; setTheme: (t: any) => void; onLogout: () => void; username: string }) {
  const { data, loading, reload } = useAsync(() => api("/api/settings"), []);
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    if (data) setS(data.settings);
  }, [data]);

  if (loading || !s) return <Spinner />;

  const save = async () => {
    try {
      await api("/api/settings", {
        method: "PUT",
        body: {
          timezone: s.timezone,
          retention_days: Number(s.retention_days),
          dedup_retention_days: Number(s.dedup_retention_days),
          any_reply_counts_as_start: !!s.any_reply_counts_as_start,
          global_user_hourly_limit: Number(s.global_user_hourly_limit),
        },
      });
      setTz(s.timezone);
      toast("تم الحفظ");
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };

  const restore = async (file: File) => {
    try {
      const body = JSON.parse(await file.text());
      const r = await api<{ campaigns: number; note: string }>("/api/settings/restore", { body });
      toast(`تمت استعادة ${r.campaigns} حملة — ${r.note}`);
    } catch (e: any) {
      toast(e.message ?? "ملف غير صالح", "bad");
    }
  };

  const del = async (scope: string, label: string) => {
    const c = prompt(`لتأكيد ${label} اكتب DELETE`);
    if (c !== "DELETE") return;
    try {
      await api("/api/data/delete", { body: { scope, confirm: "DELETE" } });
      toast("تم الحذف");
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="الإعدادات" subtitle={`مسجّل كـ ${username}`} />

      <Card title="المظهر">
        <div className="flex gap-2">
          {[["system", "حسب النظام"], ["light", "فاتح"], ["dark", "داكن"]].map(([k, v]) => (
            <button key={k} className={`btn ${theme === k ? "btn-primary" : "btn-ghost"}`} onClick={() => setTheme(k)}>{v}</button>
          ))}
        </div>
      </Card>

      <Card title="عام">
        <div className="space-y-3">
          <Field label="المنطقة الزمنية" hint="تُخزَّن الأوقات بتوقيت UTC وتُعرض بهذه المنطقة.">
            <input className="input" dir="ltr" value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} />
          </Field>
          <Field label="حد المسارات الجديدة لكل مستخدم في الساعة" hint="حماية من التكرار عبر كل الحملات (0 = بلا حد).">
            <input className="input" type="number" min={0} value={s.global_user_hourly_limit} onChange={(e) => setS({ ...s, global_user_hourly_limit: e.target.value })} />
          </Field>
          <Toggle
            checked={!!s.any_reply_counts_as_start}
            onChange={(v) => setS({ ...s, any_reply_counts_as_start: v })}
            label="أي رد من الشخص يُعد «ابدأ»"
            description="عند وجود مسار ينتظر تفاعل الشخص، تُعامل أي رسالة منه كبدء للتحقق (وليس فقط كلمة ابدأ)."
          />
        </div>
      </Card>

      <Card title="الاحتفاظ بالبيانات">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="مدة الاحتفاظ بالسجلات (أيام)" hint="بعدها تُمسح النصوص والبيانات الشخصية.">
            <input className="input" type="number" min={7} value={s.retention_days} onChange={(e) => setS({ ...s, retention_days: e.target.value })} />
          </Field>
          <Field label="مدة الاحتفاظ بمفاتيح منع التكرار (أيام)" hint="لا تقل عن 8 أيام حتى لا يتكرر الرد على إعادة إرسال Meta.">
            <input className="input" type="number" min={8} value={s.dedup_retention_days} onChange={(e) => setS({ ...s, dedup_retention_days: e.target.value })} />
          </Field>
        </div>
        <button className="btn btn-primary mt-3" onClick={save}>حفظ الإعدادات</button>
      </Card>

      <Card title="الحساب والتشخيص">
        <div className="flex flex-wrap gap-2">
          <Link to="/connection" className="btn btn-ghost">إدارة الربط والتشخيص</Link>
          <button className="btn btn-ghost" onClick={async () => { await api("/api/auth/sessions/revoke-others", { body: {} }); toast("تم تسجيل الخروج من الأجهزة الأخرى"); }}>إنهاء الجلسات الأخرى</button>
          <button className="btn btn-ghost" onClick={onLogout}>تسجيل الخروج</button>
        </div>
      </Card>

      <Card title="النسخ الاحتياطي (بدون أسرار)">
        <p className="muted mb-3 text-sm">يشمل الإعدادات والحملات والقوالب فقط. لا يشمل التوكنات أو كلمات المرور أو بيانات المتفاعلين.</p>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ghost" onClick={() => download("/api/settings/backup", `hsn-autoreply-backup.json`).catch((e) => toast(e.message, "bad"))}>تنزيل نسخة احتياطية</button>
          <label className="btn btn-ghost cursor-pointer">
            استعادة من ملف
            <input type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} />
          </label>
        </div>
      </Card>

      <Card title="حذف البيانات">
        <Alert tone="warn">الحذف نهائي. مفاتيح منع التكرار للإجراءات المعلّقة تبقى لحماية المستخدمين من الرسائل المكررة.</Alert>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn btn-ghost" onClick={() => del("demo", "حذف بيانات التجربة")}>حذف بيانات التجربة</button>
          <button className="btn btn-ghost" onClick={() => del("logs", "مسح نصوص السجلات")}>مسح نصوص السجلات</button>
          <button className="btn btn-danger" onClick={() => del("all_personal", "حذف كل البيانات الشخصية")}>حذف كل البيانات الشخصية</button>
        </div>
      </Card>

      <Card title="الإصدار">
        <div className="text-sm">
          واجهة: <b>{APP_VERSION}</b> ({isNative ? "Android" : "ويب/PWA"}) · خادم: <b>{data.app_version}</b>
        </div>
        <Link to="/download" className="btn btn-ghost mt-3">تنزيل أحدث APK</Link>
      </Card>
    </div>
  );
}
