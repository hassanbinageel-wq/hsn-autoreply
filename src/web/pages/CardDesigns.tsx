import { useEffect, useState } from "react";
import { api } from "../api";
import { Link } from "../App";
import { Alert, Card, Field, PageHeader, Spinner, Toggle, toast, useAsync } from "../components/ui";
import { CARD_SIZES, CARD_THEMES, CARD_VARIABLES, DEFAULT_CARD, type CardDesign } from "../../shared/card";
import { compressBackground, renderCard } from "../lib/card";

export function DrawsTabs({ active }: { active: "draws" | "designs" }) {
  return (
    <div className="surface-2 inline-flex rounded-full p-1 text-sm">
      <Link to="/draws" className={`rounded-full px-4 py-1.5 font-semibold ${active === "draws" ? "bg-[var(--surface)] shadow" : "muted"}`}>🎁 السحوبات</Link>
      <Link to="/draws/designs" className={`rounded-full px-4 py-1.5 font-semibold ${active === "designs" ? "bg-[var(--surface)] shadow" : "muted"}`}>🎨 تصاميم التهنئة</Link>
    </div>
  );
}

/** Live preview of a design with sample winner data. */
export function CardPreview({ design, username = "winner_name", position = 1, account }: { design: CardDesign; username?: string; position?: number; account?: string | null }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      const c = await renderCard(design, { username, position, contest: design.title, account: account ?? "your_account", drawnAt: Date.now() });
      if (alive) setSrc(c.toDataURL("image/jpeg", 0.8));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [design, username, position, account]);
  return src ? <img src={src} alt="معاينة البطاقة" className="w-full rounded-xl shadow-lg" /> : <Spinner />;
}

function Editor({ initial, onSaved, onCancel, account }: { initial: { id?: number; name: string; design: CardDesign }; onSaved: () => void; onCancel: () => void; account?: string | null }) {
  const [name, setName] = useState(initial.name);
  const [d, setD] = useState<CardDesign>(initial.design);
  const [busy, setBusy] = useState(false);
  const [previewPos, setPreviewPos] = useState(1);
  const set = (p: Partial<CardDesign>) => setD((x) => ({ ...x, ...p }));
  const applyTheme = (k: keyof typeof CARD_THEMES) => {
    const t = CARD_THEMES[k];
    set({ theme: k, bg1: t.bg1, bg2: t.bg2, accent: t.accent, text_color: t.text });
  };
  const save = async () => {
    setBusy(true);
    try {
      if (initial.id) await api(`/api/card-designs/${initial.id}`, { method: "PUT", body: { name, design: d } });
      else await api("/api/card-designs", { body: { name, design: d } });
      toast("تم حفظ التصميم");
      onSaved();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    try {
      set({ background_image: await compressBackground(f) });
    } catch {
      toast("تعذر قراءة الصورة", "bad");
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <Card title="الأساسيات">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="اسم التصميم (داخلي)"><input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="المقاس">
              <select className="input" value={d.size} onChange={(e) => set({ size: e.target.value as CardDesign["size"] })}>
                {Object.entries(CARD_SIZES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </Field>
          </div>
        </Card>
        <Card title="الألوان والخلفية">
          <div className="mb-3 flex flex-wrap gap-2">
            {Object.entries(CARD_THEMES).map(([k, t]) => (
              <button key={k} type="button" onClick={() => applyTheme(k as keyof typeof CARD_THEMES)} className={`flex items-center gap-2 rounded-full border-2 px-3 py-1.5 text-sm ${d.theme === k ? "border-[var(--color-brand-500)]" : "border-transparent surface-2"}`}>
                <span className="h-4 w-4 rounded-full" style={{ background: `linear-gradient(135deg, ${t.bg1}, ${t.bg2})`, boxShadow: `0 0 0 2px ${t.accent}` }} />
                {t.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {([["bg1", "خلفية 1"], ["bg2", "خلفية 2"], ["accent", "لون مميز"], ["text_color", "لون النص"]] as const).map(([k, l]) => (
              <Field key={k} label={l}><input type="color" className="h-10 w-full cursor-pointer rounded-lg" value={d[k]} onChange={(e) => set({ [k]: e.target.value, theme: "custom" } as any)} /></Field>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="btn btn-ghost cursor-pointer text-sm">
              🖼️ صورة خلفية (اختياري)
              <input type="file" accept="image/*" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
            </label>
            {d.background_image && <button className="btn btn-ghost text-sm" onClick={() => set({ background_image: null })}>إزالة الصورة</button>}
            {d.background_image && (
              <label className="flex items-center gap-2 text-sm">
                تعتيم
                <input type="range" min={0} max={0.9} step={0.05} value={d.background_dim} onChange={(e) => set({ background_dim: Number(e.target.value) })} />
              </label>
            )}
          </div>
        </Card>
        <Card title="النصوص">
          <div className="space-y-3">
            <Field label="عنوان المسابقة"><input className="input" value={d.title} maxLength={80} onChange={(e) => set({ title: e.target.value })} /></Field>
            <Field label="العنوان الرئيسي"><input className="input" value={d.headline} maxLength={60} onChange={(e) => set({ headline: e.target.value })} /></Field>
            <Field label="نص التهنئة"><textarea className="input min-h-[80px]" value={d.body} maxLength={300} onChange={(e) => set({ body: e.target.value })} /></Field>
            <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
              <Field label="عنوان الجائزة"><input className="input" value={d.prize_label} maxLength={30} onChange={(e) => set({ prize_label: e.target.value })} /></Field>
              <Field label="الجوائز حسب المركز" hint="سطر لكل مركز: الأول في السطر الأول، الثاني في الثاني… (المراكز الزائدة تأخذ آخر سطر)">
                <textarea className="input min-h-[90px]" value={d.prizes.join("\n")} onChange={(e) => set({ prizes: e.target.value.split("\n").slice(0, 20) })} placeholder={"آيفون 17\nسماعة AirPods\nبطاقة شحن 100 ريال"} />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="التاريخ">
                <select className="input" value={d.date_mode} onChange={(e) => set({ date_mode: e.target.value as CardDesign["date_mode"] })}>
                  <option value="draw">تاريخ السحب تلقائيًا</option>
                  <option value="custom">نص أكتبه</option>
                  <option value="none">بدون تاريخ</option>
                </select>
              </Field>
              {d.date_mode === "custom" && <Field label="نص التاريخ"><input className="input" value={d.custom_date} maxLength={40} onChange={(e) => set({ custom_date: e.target.value })} placeholder="الجمعة 1 أكتوبر" /></Field>}
              {d.date_mode !== "none" && <div className="self-end pb-2"><Toggle checked={d.show_day} onChange={(v) => set({ show_day: v })} label="إظهار اليوم" /></div>}
            </div>
            <Field label="التذييل"><input className="input" value={d.footer} maxLength={60} onChange={(e) => set({ footer: e.target.value })} /></Field>
            <Field label="نص الرسالة المرسلة مع البطاقة" hint="يُرسل مع الصورة في الخاص، أو كرد خاص على تعليق الفائز مع زر يفتح البطاقة.">
              <textarea className="input min-h-[90px]" value={d.message_text} maxLength={600} onChange={(e) => set({ message_text: e.target.value })} />
            </Field>
            <p className="muted text-xs">المتغيرات: {Object.entries(CARD_VARIABLES).map(([k, v]) => `{{${k}}} ${v}`).join(" · ")}</p>
          </div>
        </Card>
        <div className="flex gap-2">
          <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={save}>{busy ? "جارٍ الحفظ…" : "حفظ التصميم"}</button>
          <button className="btn btn-ghost" onClick={onCancel}>إلغاء</button>
        </div>
      </div>
      <div className="space-y-2 lg:sticky lg:top-4 lg:self-start">
        <div className="flex items-center justify-between text-sm">
          <b>المعاينة</b>
          <label className="flex items-center gap-1">
            المركز
            <select className="input w-auto py-1" value={previewPos} onChange={(e) => setPreviewPos(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
        <CardPreview design={d} position={previewPos} account={account} />
        <p className="muted text-xs">المعاينة ببيانات تجريبية؛ عند الإرسال يوضع اسم الفائز الحقيقي وجائزة مركزه وتاريخ السحب.</p>
      </div>
    </div>
  );
}

export function CardDesignsPage() {
  const { data, loading, reload } = useAsync(() => api<any[]>("/api/card-designs"), []);
  const { data: account } = useAsync(() => api("/api/account").then((r) => r.account).catch(() => null), []);
  const [editing, setEditing] = useState<{ id?: number; name: string; design: CardDesign } | null>(null);
  const remove = async (id: number) => {
    if (!confirm("حذف التصميم؟")) return;
    try {
      await api(`/api/card-designs/${id}`, { method: "DELETE" });
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  return (
    <div className="space-y-4">
      <PageHeader title="🎨 تصاميم بطاقات التهنئة" subtitle="صمّم بطاقة الفوز مرة وحدة، واختَرها في أي سحب لإرسالها للفائزين." actions={<DrawsTabs active="designs" />} />
      {editing ? (
        <Editor initial={editing} account={account?.username} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
      ) : (
        <>
          <button className="btn btn-primary" onClick={() => setEditing({ name: "تصميم جديد", design: { ...DEFAULT_CARD } })}>+ تصميم جديد</button>
          {loading && !data ? (
            <Spinner />
          ) : !data?.length ? (
            <Alert tone="info">لا توجد تصاميم بعد — اضغط «+ تصميم جديد». بدون تصميم تُستخدم البطاقة الافتراضية.</Alert>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {data.map((row) => {
                const design = { ...DEFAULT_CARD, ...JSON.parse(row.design) } as CardDesign;
                return (
                  <div key={row.id} className="card space-y-2 p-3">
                    <CardPreview design={design} account={account?.username} />
                    <div className="font-bold">{row.name}</div>
                    <div className="flex gap-2">
                      <button className="btn btn-ghost flex-1 text-sm" onClick={() => setEditing({ id: row.id, name: row.name, design })}>✏️ تعديل</button>
                      <button className="btn btn-ghost text-sm text-red-600" onClick={() => remove(row.id)}>🗑️</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
