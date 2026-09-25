import { useState } from "react";
import { api } from "../api";
import { isNative, openOAuth } from "../platform";
import { Alert, Badge, Card, PageHeader, Spinner, fmtTime, toast, useAsync } from "../components/ui";

const SCOPE_AR: Record<string, string> = {
  instagram_business_basic: "الملف الأساسي والمنشورات",
  instagram_business_manage_messages: "الرسائل الخاصة والردود الخاصة وملف المستخدم",
  instagram_business_manage_comments: "قراءة التعليقات والرد عليها",
};

export function ConnectionPage() {
  const { data, loading, error, reload } = useAsync(() => api("/api/account"), []);
  const [diagData, setDiagData] = useState<{ checks: Array<{ name: string; ok: boolean | null; detail?: string }> } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const status = new URLSearchParams(location.hash.split("?")[1] ?? "").get("status");

  if (loading && !data) return <Spinner />;
  if (error) return <Alert tone="bad">{error}</Alert>;
  const a = data.account;
  const connected = a && a.status !== "disconnected";

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(null);
    }
  };

  const connect = () =>
    run("connect", async () => {
      const r = await api<{ url: string }>("/api/account/connect", { body: { client: isNative ? "app" : "web" } });
      await openOAuth(r.url);
    });

  const missing = connected ? (data.required_scopes as string[]).filter((s) => !a.scopes.includes(s)) : [];

  return (
    <div className="space-y-4">
      <PageHeader title="ربط حساب إنستقرام" subtitle={`Instagram API with Instagram Login · الإصدار ${data.api_version} (تحقق: ${data.api_version_verified_at ?? "—"})`} />
      {status === "ok" && <Alert tone="good">عاد المتصفح من Meta. الحالة أدناه مقروءة من الخادم مباشرة.</Alert>}
      {status === "error" && <Alert tone="bad">لم يكتمل الربط. أعد المحاولة أو راجع دليل إعداد Meta.</Alert>}
      {!data.configured && <Alert tone="warn">لم تُضبط بيانات تطبيق Meta على الخادم (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET).</Alert>}

      <Card title="الحساب المتصل">
        {connected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              {a.profile_picture_url ? (
                <img src={a.profile_picture_url} alt="" className="h-16 w-16 rounded-full" referrerPolicy="no-referrer" />
              ) : (
                <div className="surface-2 flex h-16 w-16 items-center justify-center rounded-full text-2xl">👤</div>
              )}
              <div>
                <div className="text-lg font-bold">@{a.username ?? "—"}</div>
                <div className="muted text-sm">{a.name ?? ""} {a.account_type ? `· ${a.account_type}` : ""}</div>
                <div className="muted text-xs" dir="ltr">IG ID: {a.ig_user_id}</div>
              </div>
            </div>
            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div><dt className="muted">حالة التفويض</dt><dd><Badge value={a.status} label={a.status === "active" ? "فعّال" : a.status === "needs_reauth" ? "يحتاج إعادة ربط" : a.status} /></dd></div>
              <div><dt className="muted">انتهاء التفويض</dt><dd>{a.token_expires_at ? fmtTime(a.token_expires_at) : "غير متاح"}</dd></div>
              <div><dt className="muted">حالة Webhooks</dt><dd><Badge value={a.webhook_status} /> <span className="muted">({a.webhook_fields.join(", ") || "—"})</span></dd></div>
              <div><dt className="muted">آخر حدث وصل</dt><dd>{fmtTime(a.last_webhook_at)}</dd></div>
              <div><dt className="muted">التحقق من المتابعة</dt><dd><Badge value={a.follow_check_support} label={{ supported: "مدعوم (تم رصد الحقل)", unsupported: "غير متاح", unknown: "لم يُختبر بعد" }[a.follow_check_support as string]} /></dd></div>
              <div><dt className="muted">آخر تجديد للتوكن</dt><dd>{fmtTime(a.token_refreshed_at)}</dd></div>
            </dl>
            {a.follow_check_note && <Alert tone="warn">سبب تعذر التحقق من المتابعة: {a.follow_check_note}</Alert>}
            {a.last_error && <Alert tone="warn">آخر خطأ: {a.last_error}</Alert>}
          </div>
        ) : (
          <Alert tone="info">لا يوجد حساب متصل. سيُفتح تسجيل الدخول الرسمي من Meta في متصفح النظام — لا نطلب كلمة المرور داخل التطبيق.</Alert>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="btn btn-primary" onClick={connect} disabled={!!busy || !data.configured}>
            {connected ? "إعادة الاتصال" : "ربط عبر Instagram"}
          </button>
          {connected && (
            <>
              <button className="btn btn-ghost" disabled={!!busy} onClick={() => run("sub", async () => { await api("/api/account/resubscribe", { body: {} }); toast("تم الاشتراك في Webhooks"); reload(); })}>إعادة اشتراك Webhooks</button>
              <button className="btn btn-ghost" disabled={!!busy} onClick={() => run("ref", async () => { await api("/api/account/refresh-token", { body: {} }); toast("تم تجديد التفويض"); reload(); })}>تجديد التفويض</button>
              <button className="btn btn-ghost" disabled={!!busy} onClick={() => run("diag", async () => setDiagData(await api("/api/account/diagnostics")))}>تشخيص الربط</button>
              <button
                className="btn btn-danger"
                disabled={!!busy}
                onClick={() =>
                  run("disc", async () => {
                    if (!confirm("فصل الحساب؟ ستتوقف الأتمتة وتُلغى المهام المعلّقة ويُحذف التوكن.")) return;
                    const purge = confirm("حذف بيانات المتفاعلين والمسارات المرتبطة بهذا الحساب أيضًا؟ (موافق = حذف، إلغاء = الإبقاء)");
                    await api("/api/account/disconnect", { body: { purge } });
                    toast("تم فصل الحساب");
                    reload();
                  })
                }
              >
                فصل الحساب وإيقاف الأتمتة
              </button>
            </>
          )}
        </div>
      </Card>

      {diagData && (
        <Card title="نتيجة التشخيص">
          <ul className="space-y-2">
            {diagData.checks.map((c) => (
              <li key={c.name} className="flex items-start gap-2">
                <span>{c.ok === true ? "✅" : c.ok === false ? "❌" : "⚪"}</span>
                <span><b>{c.name}</b>{c.detail && <span className="muted"> — {c.detail}</span>}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="الصلاحيات">
        <ul className="space-y-2">
          {(data.required_scopes as string[]).map((s) => (
            <li key={s} className="flex items-start gap-2">
              <span>{connected ? (a.scopes.includes(s) ? "✅" : "❌") : "⚪"}</span>
              <span><code className="text-sm" dir="ltr">{s}</code><br /><span className="muted text-sm">{SCOPE_AR[s]}</span></span>
            </li>
          ))}
        </ul>
        {missing.length > 0 && <div className="mt-3"><Alert tone="warn">صلاحيات ناقصة: {missing.join(", ")} — أعد الربط ووافق عليها.</Alert></div>}
      </Card>

      <Card title="إعدادات تحتاجها في لوحة Meta">
        <dl className="space-y-2 text-sm">
          <div><dt className="muted">OAuth Redirect URI</dt><dd dir="ltr" className="break-all font-mono">{data.redirect_uri}</dd></div>
          <div><dt className="muted">Webhook Callback URL</dt><dd dir="ltr" className="break-all font-mono">{data.webhook_url}</dd></div>
          <div><dt className="muted">حقول Webhooks</dt><dd dir="ltr" className="font-mono">{(data.webhook_fields as string[]).join(", ")}</dd></div>
        </dl>
        <p className="muted mt-2 text-sm">الخطوات الكاملة في docs/META_SETUP.md.</p>
      </Card>
    </div>
  );
}
