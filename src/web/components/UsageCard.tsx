import { useState } from "react";
import { api } from "../api";
import { Card, Toggle, fmtTime, toast, useAsync } from "./ui";

function Bar({ label, used, limit, pct }: { label: string; used: number; limit: number; pct: number }) {
  const color = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm">
        <span>{label}</span>
        <span className="tabular-nums">
          <b>{pct}%</b> <span className="muted">({used.toLocaleString("ar")} من {limit.toLocaleString("ar")})</span>
        </span>
      </div>
      <div className="surface-2 h-2.5 overflow-hidden rounded-full">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(1, pct)}%` }} />
      </div>
    </div>
  );
}

/** Today's (estimated) share of the Cloudflare free limits, and recovery of comments whose webhook was missed. */
export function UsageCard() {
  const { data, reload } = useAsync(() => api("/api/usage"), []);
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const u = data.usage;
  const last = data.recover_last;

  const recover = async () => {
    setBusy(true);
    try {
      const r = await api("/api/recover", { body: {} });
      toast(r.skipped_reason ? `لم يُنفَّذ: ${REASON[r.skipped_reason] ?? r.skipped_reason}` : r.recovered ? `استُرجع ${r.recovered} تعليق فائت — تتم معالجتها الآن` : `فُحص ${r.media} منشور — لا توجد تعليقات فائتة ✅`);
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const setAuto = async (v: boolean) => {
    try {
      await api("/api/settings", { method: "PUT", body: { auto_recover_comments: v } });
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };

  return (
    <Card title="استهلاك اليوم من الحد المجاني">
      <div className="space-y-3">
        <Bar label="الطلبات" {...u.requests} />
        <Bar label="الكتابة في قاعدة البيانات" {...u.writes} />
        <p className="muted text-xs">
          تقدير تقريبي من نشاط اليوم (الأرقام الدقيقة في لوحة Cloudflare). يتجدد الحد {fmtTime(u.reset_at)} (03:00 بتوقيت السعودية). عند بلوغ 100% تتوقف
          الردود مؤقتًا بدون أي رسوم، ثم تكمل تلقائيًا.
        </p>
        <div className="border-t border-[var(--border)] pt-3">
          <div className="mb-2 font-semibold">استرجاع التعليقات الفائتة</div>
          <p className="muted mb-2 text-xs">
            يقرأ آخر التعليقات على منشورات حملاتك النشطة ويرد على أي تعليق مطابق لم يصل تنبيهه (خلال 7 أيام، وبعد تفعيل الحملة). لا يرد على نفس التعليق مرتين.
          </p>
          <Toggle checked={!!data.auto_recover} onChange={setAuto} label="استرجاع تلقائي كل ساعة" />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button className="btn btn-ghost" disabled={busy} onClick={recover}>{busy ? "جارٍ الفحص…" : "🔄 استرجع الآن"}</button>
            {last?.at && (
              <span className="muted text-xs">
                آخر فحص {fmtTime(last.at)}{last.auto ? " (تلقائي)" : ""}: {last.skipped_reason ? REASON[last.skipped_reason] ?? last.skipped_reason : `${last.media} منشور، استُرجع ${last.recovered}`}
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

const REASON: Record<string, string> = {
  no_account: "الحساب غير مربوط",
  automation_paused: "الأتمتة متوقفة",
  no_active_comment_campaign: "لا توجد حملة تعليقات نشطة",
  no_media: "لا توجد منشورات للفحص",
  no_token: "التفويض غير متاح — أعد الربط",
};
