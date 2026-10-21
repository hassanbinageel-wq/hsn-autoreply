import { api } from "../api";
import { askConfirm } from "./Confirm";
import { Alert, Card, fmtTime, toast, useAsync } from "./ui";
import { Icon } from "./Icon";
import { Link } from "../App";
import { isNative, openOAuth } from "../platform";
import { useEffect, useState } from "react";

/** Connect the customer's online store (Salla now, Zid later) through the platform's official approval page. */
export function StoreConnect() {
  const { data, reload } = useAsync(() => api<any>("/api/stores"), []);
  const [busy, setBusy] = useState<string | null>(null);
  // Coming back from an install started on Salla's side: claim the store for this account.
  useEffect(() => {
    const claim = new URLSearchParams(location.hash.split("?")[1] ?? "").get("claim");
    if (!claim) return;
    history.replaceState(null, "", "#/connection");
    api("/api/stores/claim", { body: { token: claim } })
      .then(() => { toast("تم ربط متجر سلة بحسابك ✅"); reload(); })
      .catch((e) => toast(e.message, "bad"));
  }, []);
  if (!data) return null;
  const salla = data.stores.find((s: any) => s.platform === "salla");
  const run = async (k: string, fn: () => Promise<void>) => {
    setBusy(k);
    try {
      await fn();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(null);
    }
  };
  const connect = () => run("connect", async () => openOAuth((await api<{ url: string }>("/api/stores/salla/connect", { body: { client: isNative ? "app" : "web" } })).url));
  const active = salla?.status === "active";
  return (
    <Card title={<span className="flex items-center gap-2"><span className="grad grid size-6 shrink-0 place-items-center rounded-full text-xs font-extrabold text-white" aria-hidden>2</span>ربط المتجر <span className="muted text-xs font-normal">(اختياري)</span></span>} action={salla ? <Link to="/store" className="btn btn-ghost min-h-9 text-xs"><Icon name="chart" size={15} />تحليل المتجر</Link> : undefined}>
      <p className="muted mb-4 text-sm">بعد ربط إنستقرام، اربط متجرك عشان تعرف كم طلب ومبيعات وربح جابت كل حملة ومنشور. الربط رسمي من المنصة بصلاحيات <b>قراءة فقط</b> (الطلبات والمنتجات)، وما نحفظ بيانات المشترين الشخصية.</p>
      {!data.plan && <Alert tone="warn">باقتك لا تشمل ربط المتجر — رقِّ باقتك من صفحة «اشتراكي».</Alert>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {/* Salla */}
        <section className={`rounded-2xl border p-4 ${salla ? (active ? "border-emerald-500/40" : "border-amber-500/50") : "border-[var(--border)]"}`} aria-label="سلة">
          <header className="flex items-center gap-3">
            <SallaLogo />
            <div className="min-w-0 flex-1">
              <div className="font-display text-base font-extrabold">سلة</div>
              <div className="muted text-xs" dir="ltr" style={{ textAlign: "right" }}>Salla</div>
            </div>
            {salla ? (
              <span className={`chip ${active ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"}`}>{active ? "● متصل" : "يحتاج إعادة ربط"}</span>
            ) : <span className="chip surface-2 muted">غير مربوط</span>}
          </header>
          {salla ? (
            <div className="mt-3 space-y-3">
              <div className="surface-2 flex items-center gap-3 rounded-xl p-2.5">
                {salla.avatar_url ? <img src={salla.avatar_url} alt="" className="size-10 rounded-lg bg-white object-contain" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} /> : <span className="grid size-10 place-items-center rounded-lg bg-white text-lg">🛍️</span>}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{salla.name ?? "متجر سلة"}</div>
                  <div className="muted truncate text-[11px]" dir="ltr" style={{ textAlign: "right" }}>{salla.domain ?? ""}</div>
                </div>
              </div>
              <dl className="muted grid grid-cols-2 gap-2 text-[11px]">
                <div><dt>مربوط من</dt><dd className="font-semibold text-[var(--text)]">{fmtTime(salla.connected_at)}</dd></div>
                <div><dt>آخر جلب للمنتجات</dt><dd className="font-semibold text-[var(--text)]">{salla.products_synced_at ? fmtTime(salla.products_synced_at) : "—"}</dd></div>
              </dl>
              {active && salla.last_error && <Alert tone="warn">{salla.last_error}</Alert>}
              {!active && <Alert tone="warn">انتهى تفويض المتجر{salla.last_error ? ` (${salla.last_error})` : ""} — اضغط «إعادة الربط».</Alert>}
              <p className="muted text-[11px]">المنتجات والطلبات تتحدث تلقائيًا لحظة تغيّرها، ومعها مراجعة يومية — زر التحديث احتياطي فقط.</p>
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-ghost min-h-10 text-sm" disabled={!!busy} onClick={connect}>إعادة الربط</button>
                {active && <button className="btn btn-ghost min-h-10 text-sm" disabled={!!busy} onClick={() => run("sync", async () => { const r = await api<any>(`/api/stores/${salla.id}/sync`, { body: {} }); toast(`تم جلب ${r.products} منتج`); reload(); })}><Icon name="refresh" size={15} />{busy === "sync" ? "…" : "تحديث المنتجات"}</button>}
                <button className="btn btn-danger min-h-10 text-sm" disabled={!!busy} onClick={() => run("del", async () => {
                  if (!(await askConfirm({ title: "فصل المتجر؟", message: "يتوقف استقبال الطلبات الجديدة. الطلبات المحفوظة تبقى في التحليل. لإزالة التطبيق نهائيًا احذفه أيضًا من لوحة تحكم سلة › التطبيقات.", confirmLabel: "فصل", danger: true }))) return;
                  await api(`/api/stores/${salla.id}`, { method: "DELETE" });
                  toast("تم فصل المتجر");
                  reload();
                })}>فصل</button>
              </div>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              <p className="muted text-xs leading-relaxed">توافق على صفحة سلة الرسمية وترجع هنا تلقائيًا. الطلبات توصل لحظة إنشائها.</p>
              {data.plan && (data.salla_configured
                ? <button className="btn btn-primary w-full" disabled={!!busy} onClick={connect}>{busy === "connect" ? "…" : "ربط متجر سلة"}</button>
                : <Alert tone="info">ربط سلة قيد التفعيل من إدارة الخدمة.</Alert>)}
            </div>
          )}
        </section>

        {/* Zid — next */}
        <section className="rounded-2xl border border-dashed border-[var(--border)] p-4" aria-label="زد">
          <header className="flex items-center gap-3">
            <ZidLogo />
            <div className="min-w-0 flex-1">
              <div className="font-display text-base font-extrabold">زد</div>
              <div className="muted text-xs" dir="ltr" style={{ textAlign: "right" }}>Zid</div>
            </div>
            <span className="chip bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300">قريبًا</span>
          </header>
          <p className="muted mt-3 text-xs leading-relaxed">ربط متاجر زد بنفس الطريقة: موافقة رسمية، قراءة فقط، وتحليل الطلبات والربح لكل حملة.</p>
          <button className="btn btn-ghost mt-3 w-full" disabled>ربط متجر زد (قريبًا)</button>
        </section>

        {/* Done (دن) — next */}
        <section className="rounded-2xl border border-dashed border-[var(--border)] p-4" aria-label="دن">
          <header className="flex items-center gap-3">
            <img src="/integrations/done.png" alt="" className="size-12 shrink-0 rounded-2xl" />
            <div className="min-w-0 flex-1">
              <div className="font-display text-base font-extrabold">دن</div>
              <div className="muted text-xs" dir="ltr" style={{ textAlign: "right" }}>Done</div>
            </div>
            <span className="chip bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300">قريبًا</span>
          </header>
          <p className="muted mt-3 text-xs leading-relaxed">ربط متاجر دن بنفس الطريقة: موافقة رسمية، قراءة فقط، وتحليل الطلبات والربح لكل حملة.</p>
          <button className="btn btn-ghost mt-3 w-full" disabled>ربط دن (قريبًا)</button>
        </section>
      </div>
    </Card>
  );
}

/** Salla's mark (from Salla's brand assets via Simple Icons) on its mint brand color. */
function SallaLogo() {
  return (
    <span className="grid size-12 shrink-0 place-items-center rounded-2xl" style={{ background: "#BAF3E6" }} aria-hidden>
      <svg viewBox="0 0 24 24" width="28" height="28" fill="#004D5A">
        <path d="M18.862 13.439a1.27 1.27 0 0 0-.81-.555 1.27 1.27 0 0 0-.964.18c-3.422 2.231-6.75 2.231-10.178 0a1.27 1.27 0 0 0-.964-.18 1.283 1.283 0 0 0-.434 2.327c2.142 1.394 4.326 2.1 6.49 2.1 2.166 0 4.348-.706 6.488-2.102a1.27 1.27 0 0 0 .555-.81 1.27 1.27 0 0 0-.18-.964zm5.103 2.82-1.171-9.764a5.24 5.24 0 0 0-5.2-4.614H6.406a5.236 5.236 0 0 0-5.198 4.612l-1.17 9.766a5.235 5.235 0 0 0 5.198 5.86h13.529a5.238 5.238 0 0 0 5.198-5.86zm-3.21 2.4c-.532.6-1.265.929-2.066.929H5.311c-.801 0-1.536-.33-2.066-.929a2.73 2.73 0 0 1-.676-2.16l1.157-9.657A2.764 2.764 0 0 1 6.468 4.41h11.064a2.765 2.765 0 0 1 2.742 2.432l1.157 9.656a2.72 2.72 0 0 1-.676 2.161" />
      </svg>
    </span>
  );
}

/** Zid wordmark placeholder (text) until the official logo is added with the Zid integration. */
function ZidLogo() {
  return (
    <span className="grid size-12 shrink-0 place-items-center rounded-2xl text-lg font-black tracking-tight text-white" style={{ background: "#5B2D90" }} dir="ltr" aria-hidden>
      zid
    </span>
  );
}
