import { useState } from "react";
import { api } from "../api";
import { Badge, Card, Modal, Spinner, Toggle, fmtTime, toast, useAsync } from "./ui";
import { REASONS } from "../pages/Logs";

/** Recovered comments: who commented, on which post, what happened and which messages the system sent. */
function RecoveredList({ onClose }: { onClose: () => void }) {
  const { data, loading } = useAsync(() => api("/api/recover/items?days=7"), []);
  return (
    <Modal open onClose={onClose} title="التعليقات المسترجعة (آخر 7 أيام)">
      {loading && !data ? (
        <Spinner />
      ) : !data?.items?.length ? (
        <p className="muted py-6 text-center text-sm">لم يُسترجع أي تعليق خلال آخر 7 أيام — كل التنبيهات وصلت في وقتها ✅</p>
      ) : (
        <div className="divide-y divide-[var(--border)]">
          {data.items.map((i: any) => {
            const answered = i.status === "processed" && i.flow_id;
            return (
              <div key={i.id} className="flex gap-3 py-3">
                <a href={i.permalink ?? undefined} target="_blank" rel="noreferrer" className="h-16 w-12 shrink-0 overflow-hidden rounded-md bg-gradient-to-br from-violet-700 via-fuchsia-600 to-orange-500">
                  {i.thumbnail_url && <img src={i.thumbnail_url} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />}
                </a>
                <div className="min-w-0 flex-1 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    {i.sender_username ? (
                      <a href={`https://www.instagram.com/${i.sender_username}`} target="_blank" rel="noreferrer" className="font-bold hover:underline" dir="ltr">@{i.sender_username}</a>
                    ) : (
                      <span className="muted font-bold">حساب غير معروف</span>
                    )}
                    {answered ? (
                      <Badge value={i.state === "content_sent" ? "content_sent" : i.state} />
                    ) : (
                      <span className="surface-2 rounded-full px-2 py-0.5 text-[11px]">لم يُرد: {REASONS[String(i.reason ?? "").split(" ")[0]] ?? i.reason ?? i.status}</span>
                    )}
                    {i.link_clicks > 0 && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] text-sky-800 dark:bg-sky-900/40 dark:text-sky-300">🔗 ضغط الرابط</span>}
                  </div>
                  <div className="mt-0.5">💬 «<span className="break-words">{i.text}</span>»</div>
                  <div className="muted text-xs">
                    {i.caption ? `على: ${i.caption.slice(0, 60)}${i.caption.length > 60 ? "…" : ""}` : `منشور ${i.media_id ?? ""}`}
                    {i.campaign_name ? ` · حملة «${i.campaign_name}»` : ""} · علّق {fmtTime(i.event_time)} · استُرجع {fmtTime(i.received_at)}
                  </div>
                  {i.sent?.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {i.sent.map((m: any, k: number) => (
                        <div key={k} className="rounded-xl bg-gradient-to-l from-violet-600 to-indigo-500 px-3 py-1.5 text-xs whitespace-pre-wrap break-words text-white">
                          {m.text}
                          <span className="block text-[10px] opacity-70">🤖 أُرسلت {fmtTime(m.created_at)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {i.public_reply_status === "accepted" && <div className="muted mt-1 text-xs">+ رد عام تحت التعليق ✅</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

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
  const [showList, setShowList] = useState(false);
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
      {showList && <RecoveredList onClose={() => setShowList(false)} />}
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
            <button className="btn btn-ghost" onClick={() => setShowList(true)}>📋 عرض التعليقات المسترجعة</button>
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
