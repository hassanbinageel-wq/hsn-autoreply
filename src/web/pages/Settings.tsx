import { useEffect, useMemo, useState, type ReactNode } from "react";
import { TwoFactorCard } from "../components/TwoFactor";
import { askText } from "../components/Confirm";
import { api, download } from "../api";
import { APP_VERSION, isNative } from "../platform";
import { Link } from "../App";
import { NotificationsCard } from "../components/NotificationsCard";
import { Icon } from "../components/Icon";
import { Alert, Card, Spinner, Toggle, setTz, toast, useAsync } from "../components/ui";
import { bioUser, disableBio } from "../lib/biometric";

const SECTIONS: Array<[string, string, string]> = [
  ["general", "عام", "settings"],
  ["notifications", "الإشعارات", "send"],
  ["privacy", "الخصوصية والاحتفاظ", "shield"],
  ["backup", "النسخ الاحتياطي", "download"],
  ["appearance", "المظهر", "sun"],
  ["security", "الأمان", "lock"],
];

/** One settings line: label + description on the right, the control on the left. */
function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1 basis-52">
        <div className="font-display text-[15px] font-bold">{label}</div>
        {hint && <div className="muted mt-0.5 text-[13px]">{hint}</div>}
      </div>
      <div className="max-w-full shrink-0">{children}</div>
    </div>
  );
}

export function SettingsPage({ theme, setTheme, onLogout, username }: { theme: string; setTheme: (t: any) => void; onLogout: () => void; username: string }) {
  const { data, loading, reload } = useAsync(() => api("/api/settings"), []);
  const [s, setS] = useState<any>(null);
  const [active, setActive] = useState("general");
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (data) setS(data.settings);
  }, [data]);
  const zones = useMemo(() => {
    try {
      return (Intl as any).supportedValuesOf?.("timeZone") as string[] | undefined;
    } catch {
      return undefined;
    }
  }, []);

  if (loading || !s) return <Spinner />;
  const edit = (patch: Record<string, unknown>) => {
    setS({ ...s, ...patch });
    setDirty(true);
  };

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
          auto_recover_comments: s.auto_recover_comments !== false,
        },
      });
      setTz(s.timezone);
      setDirty(false);
      toast("تم الحفظ — تقدر تسترجع التعديل من السجل");
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
    const c = await askText({ title: `${label}؟`, message: "ما يمكن التراجع عن الحذف.", label: "للتأكيد اكتب DELETE", expect: "DELETE", confirmLabel: label, danger: true });
    if (c !== "DELETE") return;
    try {
      await api("/api/data/delete", { body: { scope, confirm: "DELETE" } });
      toast("تم الحذف");
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };

  const go = (id: string) => {
    setActive(id);
    document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const themeSeg = (
    <div className="seg">
      {[["light", "فاتح"], ["dark", "داكن"], ["system", "تلقائي"]].map(([k, v]) => (
        <button key={k} className={theme === k ? "on" : ""} onClick={() => setTheme(k)}>{v}</button>
      ))}
    </div>
  );

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold leading-tight sm:text-[26px]">الإعدادات</h1>
          <p className="muted mt-1 text-sm">تحكم بسلوك النظام والإشعارات والخصوصية · مسجّل كـ {username}</p>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={!dirty}>
          <Icon name="check" size={18} />{dirty ? "حفظ التغييرات" : "لا توجد تغييرات"}
        </button>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
        <nav className="card h-fit min-w-0 p-2 lg:sticky lg:top-20" aria-label="أقسام الإعدادات">
          {/* Faded left edge on phones: more sections are a swipe away. */}
          <div className="flex gap-1 overflow-x-auto [mask-image:linear-gradient(to_right,transparent,black_40px)] lg:flex-col lg:[mask-image:none]">
            {SECTIONS.map(([id, label, icon]) => (
              <button key={id} onClick={() => go(id)} className={`nav-link shrink-0 ${active === id ? "on" : ""}`}>
                <Icon name={icon} size={19} />
                {label}
              </button>
            ))}
          </div>
        </nav>

        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-2">
          <section id="set-general" className="scroll-mt-24">
            <Card title="عام" className="h-full">
              <div className="divide-y divide-[var(--border)]">
                <Row label="المنطقة الزمنية" hint="الأوقات تُعرض بهذه المنطقة">
                  {zones ? (
                    <select className="input !w-48" dir="ltr" value={s.timezone} onChange={(e) => edit({ timezone: e.target.value })} aria-label="المنطقة الزمنية">
                      {!zones.includes(s.timezone) && <option value={s.timezone}>{s.timezone}</option>}
                      {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                    </select>
                  ) : (
                    <input className="input !w-48" dir="ltr" value={s.timezone} onChange={(e) => edit({ timezone: e.target.value })} aria-label="المنطقة الزمنية" />
                  )}
                </Row>
                <Row label="حد المسارات لكل شخص في الساعة" hint="حماية من التكرار عبر كل الحملات (0 = بلا حد)">
                  <input className="input !w-24 text-center" type="number" min={0} value={s.global_user_hourly_limit} onChange={(e) => edit({ global_user_hourly_limit: e.target.value })} aria-label="حد المسارات في الساعة" />
                </Row>
                <Toggle
                  checked={!!s.any_reply_counts_as_start}
                  onChange={(v) => edit({ any_reply_counts_as_start: v })}
                  label="أي رد يُعد «ابدأ»"
                  description="يكمل المسار حتى لو ما كتب «ابدأ» بالضبط"
                />
                <Toggle
                  checked={s.auto_recover_comments !== false}
                  onChange={(v) => edit({ auto_recover_comments: v })}
                  label="استرجاع التعليقات الفائتة"
                  description="كل ساعة، خلال 7 أيام (التعليقات اللي ما وصلت من Meta)"
                />
              </div>
            </Card>
          </section>

          <section id="set-notifications" className="scroll-mt-24">
            <NotificationsCard />
          </section>

          <section id="set-privacy" className="scroll-mt-24">
            <Card title="الخصوصية والاحتفاظ" className="h-full">
              <div className="divide-y divide-[var(--border)]">
                <Row label="الاحتفاظ بالسجلات (أيام)" hint="بعدها تُمسح النصوص والبيانات الشخصية">
                  <input className="input !w-24 text-center" type="number" min={7} value={s.retention_days} onChange={(e) => edit({ retention_days: e.target.value })} aria-label="مدة الاحتفاظ بالسجلات" />
                </Row>
                <Row label="مفاتيح منع التكرار (أيام)" hint="لا تقل عن 8 أيام حتى لا يتكرر الرد على إعادة إرسال Meta">
                  <input className="input !w-24 text-center" type="number" min={8} value={s.dedup_retention_days} onChange={(e) => edit({ dedup_retention_days: e.target.value })} aria-label="مدة مفاتيح منع التكرار" />
                </Row>
                <div className="space-y-3 pt-4">
                  <Alert tone="warn">الحذف نهائي ولا يمكن استرجاعه من السجل. مفاتيح منع التكرار للإجراءات المعلّقة تبقى لحماية الناس من الرسائل المكررة.</Alert>
                  <div className="flex flex-wrap gap-2">
                    <button className="btn btn-ghost text-sm" onClick={() => del("demo", "حذف بيانات التجربة")}>حذف بيانات التجربة</button>
                    <button className="btn btn-ghost text-sm" onClick={() => del("logs", "مسح نصوص السجلات")}>مسح نصوص السجلات</button>
                    <button className="btn btn-danger text-sm" onClick={() => del("all_personal", "حذف كل البيانات الشخصية")}>حذف كل البيانات الشخصية</button>
                  </div>
                </div>
              </div>
            </Card>
          </section>

          <section id="set-backup" className="scroll-mt-24">
            <Card title="النسخ الاحتياطي" action={<span className="chip surface-2 muted">بدون أسرار</span>} className="h-full">
              <p className="muted mb-4 text-sm">يشمل الإعدادات والحملات والقوالب فقط. لا يشمل التوكنات أو كلمات المرور أو بيانات المتفاعلين.</p>
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-ghost" onClick={() => download("/api/settings/backup", `hsn-autoreply-backup.json`).catch((e) => toast(e.message, "bad"))}>
                  <Icon name="download" size={17} />تنزيل نسخة احتياطية
                </button>
                <label className="btn btn-ghost cursor-pointer">
                  <Icon name="upload" size={17} />استعادة من ملف
                  <input type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} />
                </label>
              </div>
            </Card>
          </section>

          <section id="set-appearance" className="scroll-mt-24">
            <Card title="المظهر" className="h-full">
              <Row label="الوضع" hint="«تلقائي» يتبع إعداد جهازك">{themeSeg}</Row>
            </Card>
          </section>

          <section id="set-2fa" className="scroll-mt-24 empty:hidden">
            <TwoFactorCard />
          </section>

          <section id="set-security" className="scroll-mt-24">
            <Card title="الأمان والحساب" className="h-full">
              <div className="flex flex-wrap gap-2">
                <Link to="/connection" className="btn btn-ghost"><Icon name="link" size={17} />إدارة الربط والتشخيص</Link>
                <button className="btn btn-ghost" onClick={async () => { await api("/api/auth/sessions/revoke-others", { body: {} }); toast("تم تسجيل الخروج من الأجهزة الأخرى"); }}>
                  <Icon name="shield" size={17} />إنهاء الجلسات الأخرى
                </button>
                <button className="btn btn-ghost" onClick={onLogout}><Icon name="logout" size={17} />تسجيل الخروج</button>
              </div>
              {isNative && <BiometricRow />}
              <div className="muted mt-4 border-t border-[var(--border)] pt-4 text-sm">
                الإصدار: واجهة <b>{APP_VERSION}</b> ({isNative ? "Android" : "ويب/PWA"}) · خادم <b>{data.app_version}</b>
                <Link to="/download" className="mr-2 font-semibold text-violet-600 underline dark:text-violet-300">تنزيل أحدث APK</Link>
              </div>
            </Card>
          </section>
        </div>
      </div>
      {dirty && (
        <div className="fixed inset-x-0 bottom-20 z-30 flex justify-center px-4 lg:bottom-6" role="region" aria-label="تغييرات غير محفوظة">
          <div className="card flex w-full max-w-lg items-center gap-3 px-4 py-3 shadow-xl">
            <span className="min-w-0 flex-1 text-sm font-semibold">عندك تغييرات ما انحفظت</span>
            <button className="btn btn-ghost min-h-10 text-sm" onClick={() => { setS(data.settings); setDirty(false); }}>تراجع</button>
            <button className="btn btn-primary min-h-10 text-sm" onClick={save}>حفظ</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Android app: fingerprint sign-in is switched on from the login screen; here it can be switched off. */
function BiometricRow() {
  const [user, setUser] = useState(() => bioUser());
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-[var(--border)] p-3">
      <Icon name="fingerprint" size={22} className="text-violet-600" />
      <span className="flex-1 text-sm">
        <b className="block">الدخول بالبصمة</b>
        <span className="muted text-xs">{user ? `مفعّل على هذا الجوال (${user})` : "غير مفعّل — سجّل الخروج ثم ادخل بكلمة المرور وبيسألك عن التفعيل"}</span>
      </span>
      {user && (
        <button className="btn btn-ghost min-h-9 text-xs text-red-600" onClick={async () => { await disableBio(); setUser(null); toast("أُوقف الدخول بالبصمة"); }}>إيقاف</button>
      )}
    </div>
  );
}
