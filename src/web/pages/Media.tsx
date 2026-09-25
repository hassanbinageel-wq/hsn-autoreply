import { useState } from "react";
import { api } from "../api";
import { openExternal } from "../platform";
import { Alert, Card, Empty, PageHeader, Spinner, fmtTime, toast, useAsync } from "../components/ui";

export function MediaPage() {
  const [kind, setKind] = useState<"media" | "story">("media");
  const { data, loading, error, reload } = useAsync(() => api<{ items: any[]; now: number }>(`/api/media?kind=${kind}`), [kind]);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async (after?: string) => {
    setBusy(true);
    try {
      const r = await api<{ count: number; next: string | null }>("/api/media/refresh", { body: { kind, after } });
      setNext(r.next);
      toast(`تم جلب ${r.count} عنصر`);
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="المنشورات والستوري"
        subtitle="تُخزَّن المعاينات والبيانات الوصفية فقط — لا تُخزَّن الفيديوهات."
        actions={
          <button className="btn btn-primary" onClick={() => refresh()} disabled={busy}>
            {busy ? "…" : "تحديث من إنستقرام"}
          </button>
        }
      />
      <div className="flex gap-2" role="tablist">
        {(["media", "story"] as const).map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} className={`btn ${kind === k ? "btn-primary" : "btn-ghost"}`} onClick={() => { setKind(k); setNext(null); }}>
            {k === "media" ? "المنشورات والريلز" : "الستوري"}
          </button>
        ))}
      </div>
      {kind === "story" && (
        <Alert tone="info">الستوري تنتهي بعد 24 ساعة ولا تظهر بعدها في الواجهة الرسمية. ربط رد ستوري بقصة محددة ممكن فقط عندما يتضمن الحدث معرف الستوري.</Alert>
      )}
      {loading && !data ? (
        <Spinner />
      ) : error ? (
        <Alert tone="bad">{error}</Alert>
      ) : !data!.items.length ? (
        <Empty title="لا توجد عناصر محفوظة">اضغط «تحديث من إنستقرام» لجلب العناصر بعد ربط الحساب.</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {data!.items.map((m) => {
            const expired = m.kind === "story" && m.expires_at && m.expires_at < data!.now;
            return (
              <Card key={m.media_id} className="p-2">
                {m.thumbnail_url ? (
                  <img src={m.thumbnail_url} alt="" loading="lazy" referrerPolicy="no-referrer" className={`aspect-square w-full rounded-lg object-cover ${expired ? "opacity-40 grayscale" : ""}`} />
                ) : (
                  <div className="surface-2 flex aspect-square items-center justify-center rounded-lg">🎞️</div>
                )}
                <div className="mt-2 space-y-1 text-sm">
                  <div className="muted text-xs">{m.media_product_type ?? m.media_type} · {fmtTime(m.posted_at)}</div>
                  {expired && <div className="text-xs font-bold text-amber-600">منتهية / غير متاحة</div>}
                  <div className="line-clamp-2">{m.caption ?? ""}</div>
                  <div className="muted font-mono text-[11px]" dir="ltr">{m.media_id}</div>
                  {m.permalink && (
                    <button className="text-sm font-semibold text-brand-700 underline dark:text-brand-500" onClick={() => openExternal(m.permalink)}>
                      فتح في إنستقرام
                    </button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {next && kind === "media" && (
        <button className="btn btn-ghost w-full" onClick={() => refresh(next)} disabled={busy}>
          تحميل المزيد
        </button>
      )}
    </div>
  );
}
