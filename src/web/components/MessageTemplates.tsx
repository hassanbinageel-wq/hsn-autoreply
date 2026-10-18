import { useEffect, useState } from "react";
import { api } from "../api";
import { MESSAGE_LINKS } from "../../shared/plans";
import { MESSAGE_PLACEHOLDERS, type MessageTemplate, type MessageTemplates } from "../../shared/messageTemplates";
import { askConfirm } from "./Confirm";
import { Modal, Spinner, toast } from "./ui";

/** Owner's ready-made messages, shared by the notice card and the private-message window. */
let cache: { templates: MessageTemplates; defaults: MessageTemplates } | null = null;
const listeners = new Set<() => void>();
async function load(force = false) {
  if (!cache || force) cache = await api<{ templates: MessageTemplates; defaults: MessageTemplates }>("/api/owner/message-templates");
  listeners.forEach((l) => l());
  return cache;
}
function useTemplates() {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    if (!cache) load().catch((e) => toast(e.message, "bad"));
    return () => void listeners.delete(l);
  }, []);
  return cache;
}
async function save(templates: MessageTemplates) {
  await api("/api/owner/message-templates", { method: "PUT", body: templates });
  await load(true);
}

type Kind = keyof MessageTemplates;
type Draft = { title: string; body: string; link: string; days: number };

/** Template chips (tap = fill the form), save the current text as a template, and edit the list. */
export function TemplateBar({ kind, current, onPick }: { kind: Kind; current: Draft; onPick: (t: MessageTemplate) => void }) {
  const data = useTemplates();
  const [editing, setEditing] = useState(false);
  if (!data) return <Spinner />;
  const list = data.templates[kind];
  const saveCurrent = async () => {
    if (current.title.trim().length < 3) return toast("اكتب العنوان أول", "bad");
    try {
      await save({ ...data.templates, [kind]: [...list, { label: current.title.trim().slice(0, 40), title: current.title.trim(), body: current.body.trim(), link: current.link, days: current.days }] });
      toast("انحفظ كقالب — تقدر تغيّر اسمه من «تعديل القوالب»");
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="muted text-xs">قوالب جاهزة — اضغط واحد يتعبّى، وعدّل عليه براحتك:</span>
        <span className="flex shrink-0 gap-1">
          <button type="button" className="btn btn-ghost min-h-8 px-2 text-[11px]" onClick={saveCurrent}>💾 حفظ كقالب</button>
          <button type="button" className="btn btn-ghost min-h-8 px-2 text-[11px]" onClick={() => setEditing(true)}>✏️ تعديل القوالب</button>
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {list.length ? list.map((t, i) => <button key={i} type="button" className="chip surface-2" onClick={() => onPick(t)}>{t.label}</button>) : <span className="muted text-xs">ما فيه قوالب.</span>}
      </div>
      {editing && <TemplatesEditor kind={kind} onClose={() => setEditing(false)} />}
    </div>
  );
}

/** Placeholders filled per customer when sent; tap one to add it to the text. */
export function PlaceholderChips({ onInsert }: { onInsert: (key: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="muted text-[11px]">كلمات تتعبّى تلقائي لكل عميل:</span>
      {MESSAGE_PLACEHOLDERS.map((p) => (
        <button key={p.key} type="button" title={p.hint} className="chip surface-2 !py-0.5 text-[11px]" onClick={() => onInsert(p.key)}>{p.key}</button>
      ))}
    </div>
  );
}

const DAYS = [3, 7, 30, 90];
const daysLabel = (d: number) => (d === 3 ? "3 أيام" : d === 7 ? "أسبوع" : d === 30 ? "شهر" : d === 90 ? "3 شهور" : `${d} يوم`);

function TemplatesEditor({ kind, onClose }: { kind: Kind; onClose: () => void }) {
  const data = useTemplates()!;
  const [list, setList] = useState<MessageTemplate[]>(() => data.templates[kind].map((t) => ({ ...t })));
  const [busy, setBusy] = useState(false);
  const set = (i: number, p: Partial<MessageTemplate>) => setList(list.map((t, j) => (j === i ? { ...t, ...p } : t)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const n = [...list];
    [n[i], n[j]] = [n[j], n[i]];
    setList(n);
  };
  const invalid = list.some((t) => !t.label.trim() || t.title.trim().length < 3);
  const submit = async () => {
    setBusy(true);
    try {
      await save({ ...data.templates, [kind]: list.map((t) => ({ ...t, label: t.label.trim(), title: t.title.trim(), body: t.body.trim() })) });
      toast("تم حفظ القوالب");
      onClose();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    if (await askConfirm({ title: "استرجاع القوالب الأصلية؟", message: "ترجع القوالب الجاهزة الأصلية مكان قوائمك الحالية في هذا القسم (بعد ما تضغط حفظ).", confirmLabel: "استرجاع" }))
      setList(data.defaults[kind].map((t) => ({ ...t })));
  };
  return (
    <Modal open onClose={onClose} title={kind === "notice" ? "قوالب الإشعار لكل العملاء" : "قوالب الرسائل الخاصة"} center>
      <div className="space-y-3">
        <PlaceholderHint />
        <div className="max-h-[55vh] space-y-3 overflow-y-auto pe-1">
          {list.map((t, i) => (
            <div key={i} className="surface-2 space-y-2 rounded-2xl p-3">
              <div className="flex items-center gap-2">
                <input className="input min-h-9 flex-1 text-sm font-semibold" placeholder="اسم القالب (يظهر على الزر)" maxLength={40} value={t.label} onChange={(e) => set(i, { label: e.target.value })} />
                <button type="button" className="btn btn-ghost h-9 w-9 p-0" aria-label="لفوق" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="btn btn-ghost h-9 w-9 p-0" aria-label="لتحت" disabled={i === list.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button type="button" className="btn btn-ghost h-9 w-9 p-0 text-red-600" aria-label="حذف القالب" onClick={() => setList(list.filter((_, j) => j !== i))}>✕</button>
              </div>
              <input className="input text-sm" placeholder="العنوان" maxLength={200} value={t.title} onChange={(e) => set(i, { title: e.target.value })} />
              <textarea className="input min-h-[5rem] text-sm" placeholder="النص" maxLength={1000} value={t.body} onChange={(e) => set(i, { body: e.target.value })} />
              <div className="grid grid-cols-2 gap-2">
                <select className="input min-h-9 text-xs" value={t.link} onChange={(e) => set(i, { link: e.target.value })} aria-label="يفتح على">
                  {MESSAGE_LINKS.map((l) => <option key={l.to} value={l.to}>يفتح: {l.label}</option>)}
                </select>
                <select className="input min-h-9 text-xs" value={t.days} onChange={(e) => set(i, { days: Number(e.target.value) })} aria-label="المدة">
                  {(DAYS.includes(t.days) ? DAYS : [...DAYS, t.days]).map((d) => <option key={d} value={d}>تبقى: {daysLabel(d)}</option>)}
                </select>
              </div>
            </div>
          ))}
          {!list.length && <p className="muted py-4 text-center text-sm">ما فيه قوالب — أضف واحد.</p>}
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <span className="flex gap-2">
            <button type="button" className="btn btn-ghost text-xs" disabled={list.length >= 40} onClick={() => setList([...list, { label: "قالب جديد", title: "", body: "", link: "/", days: kind === "notice" ? 7 : 30 }])}>+ قالب جديد</button>
            <button type="button" className="btn btn-ghost text-xs" onClick={restore}>استرجاع الأصلية</button>
          </span>
          <span className="flex gap-2">
            <button type="button" className="btn btn-ghost" onClick={onClose}>إلغاء</button>
            <button type="button" className="btn btn-primary" disabled={busy || invalid} onClick={submit}>{busy ? "…" : "حفظ"}</button>
          </span>
        </div>
        {invalid && <p className="text-xs text-red-600">كل قالب يحتاج اسم وعنوان (3 أحرف على الأقل).</p>}
      </div>
    </Modal>
  );
}

function PlaceholderHint() {
  return (
    <p className="muted text-xs leading-relaxed">
      تقدر تستخدم في العنوان والنص: {MESSAGE_PLACEHOLDERS.map((p) => `${p.key} (${p.hint})`).join("، ")} — تتعبّى تلقائي لكل عميل وقت الإرسال.
    </p>
  );
}
