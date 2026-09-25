import { api } from "../api";
import { APP_VERSION, isNative, openExternal } from "../platform";
import { Alert, Card, PageHeader, Spinner, useAsync } from "../components/ui";

export function DownloadPage() {
  const { data, loading } = useAsync(() => api("/api/app/version"), []);
  if (loading || !data) return <Spinner />;
  const newer = isNative && data.version && data.version !== APP_VERSION;
  return (
    <div className="space-y-4">
      <PageHeader title="تنزيل التطبيق" subtitle="Android APK موقّع + نسخة ويب قابلة للتثبيت (PWA)" />
      {newer && <Alert tone="info">يتوفر إصدار أحدث ({data.version}). إصدارك الحالي {APP_VERSION}.</Alert>}
      <Card title={`أحدث إصدار: ${data.version}`}>
        <div className="space-y-3 text-sm">
          {data.apk_url ? (
            <button className="btn btn-primary w-full" onClick={() => openExternal(data.apk_url)}>تنزيل APK مباشرة</button>
          ) : null}
          {data.releases_url ? (
            <button className="btn btn-ghost w-full" onClick={() => openExternal(data.releases_url)}>صفحة الإصدارات على GitHub (SHA-256 وملاحظات التغييرات)</button>
          ) : (
            <Alert tone="warn">لم يُضبط رابط الإصدارات على الخادم (RELEASES_URL).</Alert>
          )}
          <Alert tone="info">
            المستودع خاص: تنزيل ملف الإصدار من GitHub يتطلب تسجيل الدخول بحساب GitHub مخوّل للوصول للمستودع. لا نضع أي Token داخل الرابط.
          </Alert>
          <ol className="list-inside list-decimal space-y-1">
            <li>نزّل ملف <code>hsn-autoreply-vX.Y.Z.apk</code> وتحقق من بصمة SHA-256 المنشورة مع الإصدار.</li>
            <li>اسمح بتثبيت التطبيقات من هذا المصدر عند الطلب.</li>
            <li>التحديثات تُثبَّت فوق النسخة الحالية لأنها موقّعة بنفس المفتاح.</li>
          </ol>
        </div>
      </Card>
      <Card title="تثبيت نسخة الويب (PWA)">
        <p className="text-sm">افتح لوحة التحكم في Chrome أو Safari ثم اختر «إضافة إلى الشاشة الرئيسية» / «تثبيت التطبيق».</p>
      </Card>
      <p className="muted text-xs">نسخة iOS غير متاحة للتثبيت العام ضمن التوزيع المجاني؛ استخدم PWA على iPhone.</p>
    </div>
  );
}
