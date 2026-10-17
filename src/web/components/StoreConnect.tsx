import { api } from "../api";
import { askConfirm } from "./Confirm";
import { Alert, Card, fmtTime, toast, useAsync } from "./ui";
import { Icon } from "./Icon";
import { Link } from "../App";
import { isNative, openOAuth } from "../platform";
import { useState } from "react";

/** Connect the customer's online store (Salla now, Zid later) through the platform's official approval page. */
export function StoreConnect() {
  const { data, reload } = useAsync(() => api<any>("/api/stores"), []);
  const [busy, setBusy] = useState<string | null>(null);
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
  return (
    <Card title="ربط المتجر" action={salla ? <Link to="/store" className="btn btn-ghost min-h-9 text-xs"><Icon name="chart" size={15} />تحليل المتجر</Link> : undefined}>
      <p className="muted mb-3 text-sm">اربط متجرك عشان تعرف كم طلب ومبيعات جابت كل حملة ومنشور. الربط رسمي من سلة بصلاحيات <b>قراءة فقط</b> (الطلبات والمنتجات والعروض)، وما نحفظ بيانات المشترين الشخصية.</p>
      {!data.plan ? (
        <Alert tone="warn">باقتك لا تشمل ربط المتجر — رقِّ باقتك من صفحة «اشتراكي».</Alert>
      ) : salla ? (
        <div className="space-y-3">
          <div className="surface-2 flex flex-wrap items-center gap-3 rounded-2xl p-3">
            {salla.avatar_url ? <img src={salla.avatar_url} alt="" className="size-11 rounded-xl object-cover" /> : <span className="grid size-11 place-items-center rounded-xl bg-emerald-500/15 text-lg">🛍️</span>}
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{salla.name ?? "متجر سلة"} <span className="muted text-xs">· سلة</span></div>
              <div className="muted text-xs" dir="ltr" style={{ textAlign: "right" }}>{salla.domain ?? ""}</div>
              <div className="muted text-xs">مربوط من {fmtTime(salla.connected_at)}{salla.products_synced_at ? ` · آخر جلب للمنتجات ${fmtTime(salla.products_synced_at)}` : ""}</div>
            </div>
            <span className={`chip ${salla.status === "active" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"}`}>{salla.status === "active" ? "متصل" : "يحتاج إعادة ربط"}</span>
          </div>
          {salla.status !== "active" && <Alert tone="warn">انتهى تفويض المتجر{salla.last_error ? ` (${salla.last_error})` : ""} — اضغط «إعادة الربط».</Alert>}
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-ghost" disabled={!!busy} onClick={connect}>إعادة الربط</button>
            {salla.status === "active" && <button className="btn btn-ghost" disabled={!!busy} onClick={() => run("sync", async () => { const r = await api<any>(`/api/stores/${salla.id}/sync`, { body: {} }); toast(`تم جلب ${r.products} منتج`); reload(); })}>{busy === "sync" ? "…" : "تحديث المنتجات"}</button>}
            <button className="btn btn-danger" disabled={!!busy} onClick={() => run("del", async () => {
              if (!(await askConfirm({ title: "فصل المتجر؟", message: "يتوقف استقبال الطلبات الجديدة. الطلبات المحفوظة تبقى في التحليل. لإزالة التطبيق نهائيًا احذفه أيضًا من لوحة تحكم سلة › التطبيقات.", confirmLabel: "فصل", danger: true }))) return;
              await api(`/api/stores/${salla.id}`, { method: "DELETE" });
              toast("تم فصل المتجر");
              reload();
            })}>فصل المتجر</button>
          </div>
        </div>
      ) : !data.salla_configured ? (
        <Alert tone="info">ربط سلة قيد التفعيل من إدارة الخدمة.</Alert>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" disabled={!!busy} onClick={connect}>{busy === "connect" ? "…" : "🛍️ ربط متجر سلة"}</button>
          <button className="btn btn-ghost" disabled title="قريبًا">ربط متجر زد (قريبًا)</button>
        </div>
      )}
    </Card>
  );
}
