import { Link } from "../App";
import { Icon } from "../components/Icon";
import { api } from "../api";
import { Card, PageHeader, fmtTime, useAsync } from "../components/ui";

/**
 * Scheduling. Campaign start/end times already work (campaign editor → «الجدول والأولوية والتكرار»).
 * Publishing posts/reels/stories needs the content-publishing permission and public file storage, which the owner
 * has not enabled yet — so nothing here pretends that automatic publishing is available.
 */
export function SchedulePage() {
  const { data: campaigns } = useAsync(() => api<any[]>("/api/campaigns"), []);
  const scheduled = (campaigns ?? []).filter((c) => c.schedule_start || c.schedule_end);
  return (
    <div className="space-y-5">
      <PageHeader title="الجدولة" subtitle="جدولة الحملات تعمل الآن. جدولة نشر المنشورات والريلز والستوري تحتاج تفعيل صلاحية النشر أولًا." />

      <Card title="الحملات المجدولة" action={<Link to="/campaigns/new" className="btn btn-primary min-h-9 text-xs"><Icon name="plus" size={15} />حملة جديدة</Link>}>
        <p className="muted mb-3 text-sm">حدد بداية ونهاية أي حملة من محرر الحملة ← خطوة «الجدول والأولوية والتكرار». الحملة ترد فقط داخل الفترة، والرسائل تلتزم بنوافذ Meta وقت التنفيذ.</p>
        {!scheduled.length ? (
          <p className="muted py-4 text-center text-sm">ما فيه حملات بموعد محدد. الحملات بدون موعد تشتغل طول ما هي «نشطة».</p>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {scheduled.map((c) => {
              const now = Date.now();
              const state = c.schedule_end && c.schedule_end < now ? "انتهت" : c.schedule_start && c.schedule_start > now ? "مجدولة" : c.status === "active" ? "تعمل الآن" : "متوقفة";
              return (
                <div key={c.id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <span className="chip surface-2">{state}</span>
                  <b className="min-w-0 flex-1 truncate">{c.name}</b>
                  <span className="muted text-xs">{c.schedule_start ? `من ${fmtTime(c.schedule_start)}` : "من التفعيل"} — {c.schedule_end ? `إلى ${fmtTime(c.schedule_end)}` : "بدون نهاية"}</span>
                  <Link to={`/campaigns/${c.id}`} className="btn btn-ghost min-h-9 px-3 text-xs">تعديل</Link>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="جدولة نشر المحتوى" action={<span className="chip bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">غير مفعّلة بعد</span>}>
        <div className="space-y-3 text-sm">
          <p>نشر بوست بصورة، أو منشور متعدد (Carousel)، أو ريل، أو ستوري في وقت تحدده، مع تقويم شهري وأسبوعي وربط المنشور بحملة تبدأ أول ما يُنشر.</p>
          <p className="muted">علشان تشتغل لازم:</p>
          <ol className="muted list-decimal space-y-1 pr-5">
            <li>صلاحية النشر الرسمية من Meta <span dir="ltr">(instagram_business_content_publish)</span> — تحتاج إعادة ربط الحساب، وتنضاف لمراجعة التطبيق.</li>
            <li>مكان لحفظ الصور والفيديوهات برابط عام (Meta تسحب الملفات منه وقت النشر) — Cloudflare R2، مجاني لين 10 جيجا.</li>
            <li>حد Meta: عدد محدود من المنشورات عبر الواجهة كل 24 ساعة لكل حساب، والصور بصيغة JPEG.</li>
          </ol>
          <p className="muted">ما راح نعرض زر نشر تلقائي قبل ما تكون هذي المتطلبات جاهزة.</p>
        </div>
      </Card>
    </div>
  );
}
