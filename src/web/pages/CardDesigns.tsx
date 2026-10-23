import { useEffect, useRef, useState } from "react";
import { askConfirm } from "../components/Confirm";
import { api } from "../api";
import { Link } from "../App";
import { Alert, Card, Field, PageHeader, Spinner, Toggle, toast, useAsync } from "../components/ui";
import { CARD_FONTS, CARD_ICONS, CARD_LAYOUTS, CARD_SIZES, CARD_THEMES, CARD_VARIABLES, DEFAULT_CARD, type CardDesign } from "../../shared/card";
import { RemixIcon, remixExists, remixName } from "../components/RemixIcon";
import { compressBackground, compressLogo, loadCardFont, renderCard } from "../lib/card";

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
  return src ? <img src={src} alt="معاينة البطاقة" draggable={false} className="w-full rounded-xl shadow-lg" /> : <Spinner />;
}

type DragTarget = "logo" | number;

/**
 * Lets the owner drag the logo and the icons on the preview: pressing picks the nearest one, a live outline follows
 * the finger while the card re-renders.
 */
function DragArea({ design, onMove, children }: { design: CardDesign; onMove: (t: DragTarget, x: number, y: number) => void; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<DragTarget | null>(null);
  const target = useRef<DragTarget | null>(null);
  const [aspect, setAspect] = useState(1);
  useEffect(() => {
    if (!design.logo_image) return;
    const img = new Image();
    img.onload = () => setAspect(img.height / img.width || 1);
    img.src = design.logo_image;
  }, [design.logo_image]);
  const icons = design.icons ?? [];
  if (!design.logo_image && !icons.length) return <>{children}</>;
  const size = CARD_SIZES[design.size];
  const items: Array<{ t: DragTarget; x: number; y: number; w: number; h: number }> = [];
  if (design.logo_image) items.push({ t: "logo", x: design.logo_x, y: design.logo_y, w: design.logo_size, h: (design.logo_size * size.w * aspect) / size.h });
  icons.forEach((ic, i) => items.push({ t: i, x: ic.x, y: ic.y, w: ic.size, h: (ic.size * size.w) / size.h }));
  const pos = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return { x: Math.round(clamp((e.clientX - r.left) / r.width) * 1000) / 1000, y: Math.round(clamp((e.clientY - r.top) / r.height) * 1000) / 1000 };
  };
  const end = () => {
    target.current = null;
    setActive(null);
  };
  return (
    <div
      ref={box}
      className="relative touch-none select-none"
      style={{ aspectRatio: `${size.w} / ${size.h}` }}
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        e.preventDefault();
        const p = pos(e);
        const near = items.reduce((best, it) => (Math.hypot(it.x - p.x, it.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y) ? it : best));
        box.current?.setPointerCapture?.(e.pointerId);
        target.current = near.t;
        setActive(near.t);
        onMove(near.t, p.x, p.y);
      }}
      onPointerMove={(e) => {
        if (target.current === null) return;
        const p = pos(e);
        onMove(target.current, p.x, p.y);
      }}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {children}
      {items.map((it) => (
        <div
          key={String(it.t)}
          className={`pointer-events-none absolute rounded-md border-2 border-dashed ${active === it.t ? "border-white bg-white/20" : "border-white/60"}`}
          style={{ left: `${(it.x - it.w / 2) * 100}%`, top: `${(it.y - it.h / 2) * 100}%`, width: `${it.w * 100}%`, height: `${it.h * 100}%`, boxShadow: "0 0 0 1px rgba(0,0,0,.4)" }}
        />
      ))}
    </div>
  );
}

type CardFontRow = { id: string; name: string; size: number };

/** The customer's own fonts: upload (with the license confirmation, 2 MB, two fonts at most), pick, delete. */
function CustomFonts({ design, set }: { design: CardDesign; set: (p: Partial<CardDesign>) => void }) {
  const { data: fonts, reload } = useAsync(() => api<CardFontRow[]>("/api/card-fonts"), []);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const upload = async () => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return toast("الخط أكبر من 2 ميقا", "bad");
    setBusy(true);
    try {
      const data = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = () => rej(r.error);
        r.readAsDataURL(file);
      });
      const r = await api<{ font: CardFontRow }>("/api/card-fonts", { body: { name: (name || file.name.replace(/\.[^.]+$/, "")).slice(0, 40), data, licensed: true } });
      if (!(await loadCardFont(r.font.id))) toast("انرفع الخط لكن المتصفح ما قدر يقرأه — جرّب ملف ثاني", "bad");
      else toast("انرفع الخط ✅");
      set({ custom_font: r.font.id });
      setFile(null);
      setName("");
      setOk(false);
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (f: CardFontRow) => {
    if (!(await askConfirm({ title: `حذف خط «${f.name}»؟`, message: "التصاميم اللي تستخدمه ترجع لخط النظام.", confirmLabel: "حذف", danger: true }))) return;
    await api(`/api/card-fonts/${f.id}`, { method: "DELETE" }).catch((e) => toast(e.message, "bad"));
    if (design.custom_font === f.id) set({ custom_font: null });
    reload();
  };
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-[var(--border)] p-3">
      <b className="text-sm">خطوطي</b>
      {(fonts ?? []).map((f) => (
        <div key={f.id} className="flex items-center gap-2 text-sm">
          <button type="button" className={`flex-1 rounded-lg border px-3 py-2 text-right ${design.custom_font === f.id ? "border-violet-500 bg-violet-500/10" : "border-[var(--border)]"}`} onClick={() => set({ custom_font: design.custom_font === f.id ? null : f.id })}>
            {design.custom_font === f.id ? "✓ " : ""}{f.name} <span className="muted text-xs">({Math.round(f.size / 1024)} KB)</span>
          </button>
          <button type="button" className="btn btn-ghost min-h-9 px-2 text-xs text-red-600" onClick={() => remove(f)}>حذف</button>
        </div>
      ))}
      {(fonts?.length ?? 0) < 2 && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <label className="btn btn-ghost cursor-pointer text-sm">
              🔤 {file ? file.name : "اختر ملف خط (TTF / OTF / WOFF)"}
              <input type="file" accept=".ttf,.otf,.woff,.woff2,font/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            {file && <input className="input min-w-0 flex-1" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="اسم الخط (اختياري)" />}
          </div>
          {file && (
            <>
              <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" className="mt-0.5" checked={ok} onChange={(e) => setOk(e.target.checked)} />
                <span>⚠️ أتأكد إن عندي حق استخدام هذا الخط تجاريًا (ترخيص الخط مسؤوليتي). الحد 2 ميقا للخط وخطّين فقط.</span>
              </label>
              <button type="button" className="btn btn-primary text-sm" disabled={!ok || busy} onClick={upload}>{busy ? "…" : "رفع الخط"}</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Icons on the card: pick from a short list (or any Remix Icon name), then size, colour and drag on the preview. */
function IconsCard({ design, set }: { design: CardDesign; set: (p: Partial<CardDesign>) => void }) {
  const icons = design.icons ?? [];
  const [other, setOther] = useState("");
  const add = (name: string) => {
    if (icons.length >= 12) return toast("الحد 12 أيقونة", "bad");
    set({ icons: [...icons, { name, x: 0.5, y: 0.5, size: 0.12, color: design.accent, opacity: 1 }] });
    toast("اسحب الأيقونة على المعاينة لمكانها");
  };
  const edit = (i: number, p: Partial<CardDesign["icons"][number]>) => set({ icons: icons.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  return (
    <Card title="الأيقونات">
      <div className="flex flex-wrap gap-1.5">
        {CARD_ICONS.map((n) => (
          <button key={n} type="button" title={n} className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border)] hover:bg-[var(--surface-2)]" onClick={() => add(n)}>
            <RemixIcon name={n} size={20} />
          </button>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input className="input" dir="ltr" value={other} onChange={(e) => setOther(e.target.value)} placeholder="أيقونة ثانية من remixicon.com مثل cup-fill" />
        <button type="button" className="btn btn-ghost shrink-0 text-sm" onClick={async () => { const n = remixName(other); if (n && (await remixExists(n))) { add(n); setOther(""); } else toast("ما لقينا هالأيقونة — انسخ اسمها من remixicon.com", "bad"); }}>إضافة</button>
      </div>
      {icons.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="muted text-xs">✋ اسحب أي أيقونة على المعاينة لمكانها.</p>
          {icons.map((ic, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] p-2 text-sm">
              <RemixIcon name={ic.name} size={22} />
              <input type="color" className="h-9 w-12 cursor-pointer rounded-lg" value={ic.color} onChange={(e) => edit(i, { color: e.target.value })} aria-label="لون الأيقونة" />
              <label className="flex min-w-[8rem] flex-1 items-center gap-2 text-xs">الحجم<input type="range" className="w-full" min={0.03} max={0.5} step={0.01} value={ic.size} onChange={(e) => edit(i, { size: Number(e.target.value) })} /></label>
              <label className="flex min-w-[8rem] flex-1 items-center gap-2 text-xs">الشفافية<input type="range" className="w-full" min={0.2} max={1} step={0.05} value={ic.opacity ?? 1} onChange={(e) => edit(i, { opacity: Number(e.target.value) })} /></label>
              <button type="button" className="btn btn-ghost min-h-9 px-2 text-xs text-red-600" onClick={() => set({ icons: icons.filter((_, j) => j !== i) })}>حذف</button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
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
  const uploadLogo = async (f: File | undefined) => {
    if (!f) return;
    try {
      set({ logo_image: await compressLogo(f) });
      toast("اسحب الشعار على المعاينة لتحديد مكانه");
    } catch {
      toast("تعذر قراءة الشعار", "bad");
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
            <Field label="الشكل">
              <select className="input" value={d.layout} onChange={(e) => { const layout = e.target.value as CardDesign["layout"]; set(layout === "template" ? { layout, background_dim: 0 } : { layout }); }}>
                {Object.entries(CARD_LAYOUTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="الخط">
              <select className="input" value={d.font} disabled={!!d.custom_font} onChange={(e) => set({ font: e.target.value as CardDesign["font"] })}>
                {Object.entries(CARD_FONTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </Field>
            <div className="sm:col-span-2"><CustomFonts design={d} set={set} /></div>
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
              🖼️ {d.layout === "template" ? "ارفع قالبك (صورة التصميم)" : "صورة خلفية / قالب (اختياري)"}
              <input type="file" accept="image/*" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
            </label>
            {d.background_image && <button className="btn btn-ghost text-sm" onClick={() => set({ background_image: null })}>إزالة الصورة</button>}
            <span className="muted w-full text-[11px]">الصورة تتصغّر تلقائيًا (عرض 1080 بكسل وحجم أقل من 1 ميقا تقريبًا). اختر «قالبك الجاهز» في الشكل لو صورتك تصميم كامل وتبي النصوص فوقها بدون زخارف.</span>
            {d.background_image && (
              <label className="flex items-center gap-2 text-sm">
                تعتيم
                <input type="range" min={0} max={0.9} step={0.05} value={d.background_dim} onChange={(e) => set({ background_dim: Number(e.target.value) })} />
              </label>
            )}
          </div>
        </Card>
        <Card title="الشعار">
          <div className="flex flex-wrap items-center gap-2">
            <label className="btn btn-ghost cursor-pointer text-sm">
              🏷️ {d.logo_image ? "تغيير الشعار" : "رفع شعار (PNG شفاف أفضل)"}
              <input type="file" accept="image/png,image/webp,image/jpeg" className="hidden" onChange={(e) => uploadLogo(e.target.files?.[0])} />
            </label>
            {d.logo_image && <button className="btn btn-ghost text-sm text-red-600" onClick={() => set({ logo_image: null })}>إزالة الشعار</button>}
          </div>
          {d.logo_image && (
            <div className="mt-3 space-y-3">
              <p className="muted text-xs">✋ اسحب الشعار مباشرة على المعاينة لوضعه في المكان اللي تبيه، أو اختر مكانًا جاهزًا:</p>
              <div className="grid w-40 grid-cols-3 gap-1">
                {[0.1, 0.5, 0.9].flatMap((y) =>
                  [0.88, 0.5, 0.12].map((x) => (
                    <button
                      key={`${x}-${y}`}
                      type="button"
                      title="ضع الشعار هنا"
                      onClick={() => set({ logo_x: x, logo_y: y })}
                      className={`h-8 rounded-md border ${Math.abs(d.logo_x - x) < 0.02 && Math.abs(d.logo_y - y) < 0.02 ? "border-[var(--color-brand-500)] bg-[var(--color-brand-500)]/20" : "surface-2 border-transparent"}`}
                    >
                      •
                    </button>
                  )),
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="text-sm">
                  الحجم
                  <input type="range" className="w-full" min={0.05} max={0.6} step={0.01} value={d.logo_size} onChange={(e) => set({ logo_size: Number(e.target.value) })} />
                </label>
                <label className="text-sm">
                  الشفافية
                  <input type="range" className="w-full" min={0.2} max={1} step={0.05} value={d.logo_opacity} onChange={(e) => set({ logo_opacity: Number(e.target.value) })} />
                </label>
                <Field label="الشكل">
                  <select className="input" value={d.logo_shape} onChange={(e) => set({ logo_shape: e.target.value as CardDesign["logo_shape"] })}>
                    <option value="original">كما هو</option>
                    <option value="circle">دائري</option>
                    <option value="rounded">مربع بحواف دائرية</option>
                  </select>
                </Field>
              </div>
            </div>
          )}
        </Card>
        <IconsCard design={d} set={set} />
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
            <Field label="نص الرد العام تحت تعليق الفائز" hint="يُستخدم فقط إذا لم يعد مسموحًا مراسلته في الخاص (بعد 7 أيام من تعليقه) وتختار نشره يدويًا.">
              <textarea className="input min-h-[70px]" value={d.public_reply_text} maxLength={600} onChange={(e) => set({ public_reply_text: e.target.value })} />
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
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
        <DragArea design={d} onMove={(t, x, y) => (t === "logo" ? set({ logo_x: x, logo_y: y }) : setD((cur) => ({ ...cur, icons: (cur.icons ?? []).map((ic, j) => (j === t ? { ...ic, x, y } : ic)) })))}>
          <CardPreview design={d} position={previewPos} account={account} />
        </DragArea>
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
    if (!(await askConfirm({ title: "حذف التصميم؟", message: "ينحذف التصميم نهائيًا.", confirmLabel: "حذف التصميم", danger: true }))) return;
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
