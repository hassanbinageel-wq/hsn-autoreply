import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "./Icon";
import { Alert, Card, Field, InfoDot, Spinner, Toggle, toast } from "./ui";
import { emptyMenu, maxOptions, menuProblem, MENU_LIMITS, newKey, TRIGGER_LABELS, type DmMenu, type MenuNode } from "../../shared/menu";

/** «القائمة التلقائية»: whoever writes to the account gets a menu; each option sends its own reply (sub-menus allowed). */
export function DmMenuEditor() {
  const [menu, setMenu] = useState<DmMenu | null>(null);
  const [available, setAvailable] = useState(true);
  const [taps, setTaps] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    api<{ menu: DmMenu; available: boolean; taps: Record<string, number> }>("/api/dm-menu")
      .then((r) => { setMenu(r.menu ?? emptyMenu()); setAvailable(r.available); setTaps(r.taps); })
      .catch((e) => toast(e.message, "bad"));
  }, []);
  if (!menu) return <Spinner />;
  const update = (m: DmMenu) => { setMenu(m); setDirty(true); };
  const problem = menuProblem(menu.root);
  const save = async (next = menu) => {
    const p = menuProblem(next.root);
    if (p) return toast(p, "bad");
    setBusy(true);
    try {
      await api("/api/dm-menu", { method: "PUT", body: next });
      setMenu(next);
      setDirty(false);
      toast(next.enabled ? "تم الحفظ — القائمة شغّالة ✅" : "تم الحفظ");
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-5">
        {!available && (
          <Alert tone="warn">
            القائمة التلقائية مو ضمن باقتك الحالية. تقدر تجهّزها الحين، وتفعيلها يحتاج باقة فيها الميزة — <a className="font-bold underline" href="#/subscription">اشتراكي</a>.
          </Alert>
        )}
        <Card title={<span className="inline-flex items-center gap-1.5">القائمة التلقائية <InfoDot text="أي شخص يراسل حسابك (خارج الحملات) توصله رسالة فيها خيارات، وكل خيار يرسل رد تكتبه أنت، وتقدر تسوي قوائم فرعية. النظام يرد فقط على اللي راسلك أول (ضمن 24 ساعة من رسالته). كل رسالة يرسلها النظام تنحسب من رسائل باقتك، والضغط على الأزرار نفسه ما ينحسب." /></span>}>
          <div className="space-y-3">
            <Toggle
              checked={menu.enabled}
              disabled={!available && !menu.enabled}
              onChange={(v) => save({ ...menu, enabled: v })}
              label="القائمة شغّالة"
              description={menu.enabled ? "توصل لكل شخص يراسلك حسب القاعدة تحت." : "مطفأة — ما يوصل شي."}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="متى تُرسل القائمة؟">
                <select className="input" value={menu.trigger} onChange={(e) => update({ ...menu, trigger: e.target.value as DmMenu["trigger"] })}>
                  {(Object.keys(TRIGGER_LABELS) as Array<DmMenu["trigger"]>).map((k) => <option key={k} value={k}>{TRIGGER_LABELS[k]}</option>)}
                </select>
              </Field>
              <Field label={<span className="inline-flex items-center gap-1">بعد ما ترد بنفسك <InfoDot text="إذا رديت على شخص بيدك (من صندوق الرسائل أو من تطبيق إنستقرام)، القائمة ما ترسل له طول هالمدة عشان ما تقاطع محادثتك." /></span>}>
                <select className="input" value={menu.pause_hours} onChange={(e) => update({ ...menu, pause_hours: Number(e.target.value) })}>
                  {[0, 2, 6, 12, 24, 48, 72].map((h) => <option key={h} value={h}>{h === 0 ? "لا تتوقف" : `توقف ${h} ساعة`}</option>)}
                </select>
              </Field>
            </div>
          </div>
        </Card>
        <Card title="رسالة القائمة والخيارات">
          <NodeEditor node={menu.root} depth={0} taps={taps} onChange={(root) => update({ ...menu, root })} />
        </Card>
        <div className="sticky bottom-20 z-10 flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-lg lg:bottom-4">
          <button className="btn btn-primary" disabled={busy || !!problem || !dirty} onClick={() => save()}>{busy ? "…" : "حفظ القائمة"}</button>
          <span className={`text-xs ${problem ? "text-red-600" : "muted"}`}>{problem ?? (dirty ? "فيه تعديلات ما انحفظت" : "محفوظة")}</span>
        </div>
      </div>
      <div className="xl:sticky xl:top-4 xl:self-start">
        <Card title="معاينة">
          <Preview root={menu.root} />
          <p className="muted mt-3 text-xs">الشكل في إنستقرام قد يختلف قليلًا حسب الجوال. الأزرار السريعة تختفي بعد الضغط، وأزرار الرسالة تبقى.</p>
        </Card>
      </div>
    </div>
  );
}

function NodeEditor({ node, depth, taps, onChange }: { node: MenuNode; depth: number; taps: Record<string, number>; onChange: (n: MenuNode) => void }) {
  const max = maxOptions(node);
  const canNest = depth < MENU_LIMITS.depth - 1;
  const setChild = (i: number, c: MenuNode | null) => onChange({ ...node, children: c ? node.children.map((x, j) => (j === i ? c : x)) : node.children.filter((_, j) => j !== i) });
  const move = (i: number, d: -1 | 1) => {
    const ch = [...node.children];
    [ch[i], ch[i + d]] = [ch[i + d], ch[i]];
    onChange({ ...node, children: ch });
  };
  return (
    <div className="space-y-3">
      {depth > 0 && (
        <Field label="عنوان الزر" hint={`${node.label.length}/${MENU_LIMITS.label}`}>
          <input className="input" maxLength={MENU_LIMITS.label} value={node.label} onChange={(e) => onChange({ ...node, label: e.target.value })} />
        </Field>
      )}
      <Field label={depth === 0 ? "نص الرسالة" : "الرد لما يضغط الزر"} hint={`${node.text.length}/${MENU_LIMITS.text}`}>
        <textarea className="input min-h-[5.5rem]" maxLength={MENU_LIMITS.text} value={node.text} onChange={(e) => onChange({ ...node, text: e.target.value })} />
      </Field>
      {node.link ? (
        <div className="grid gap-2 rounded-xl border border-[var(--border)] p-2.5 sm:grid-cols-[1fr_1.6fr_auto]">
          <input className="input" maxLength={MENU_LIMITS.label} value={node.link.title} onChange={(e) => onChange({ ...node, link: { ...node.link!, title: e.target.value } })} aria-label="عنوان زر الرابط" placeholder="عنوان الزر" />
          <input className="input" dir="ltr" value={node.link.url} onChange={(e) => onChange({ ...node, link: { ...node.link!, url: e.target.value.trim() } })} aria-label="الرابط" placeholder="https://" />
          <button type="button" className="btn btn-ghost min-h-10 text-xs text-red-600" onClick={() => onChange({ ...node, link: null })}>حذف الرابط</button>
        </div>
      ) : (
        <button type="button" className="text-xs font-semibold text-violet-700 underline dark:text-violet-300" onClick={() => onChange({ ...node, link: { title: "افتح الرابط", url: "https://" } })}>+ زر رابط</button>
      )}
      {(canNest || node.children.length > 0) && (
        <div className="rounded-2xl bg-[var(--surface-2)] p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <b className="flex-1 text-sm">{depth === 0 ? "الخيارات" : "خيارات فرعية"} ({node.children.length}/{max})</b>
            <div className="flex rounded-xl border border-[var(--border)] bg-[var(--surface)] p-0.5 text-xs font-bold">
              {(["buttons", "quick"] as const).map((st) => (
                <button key={st} type="button" onClick={() => onChange({ ...node, style: st })} className={`rounded-lg px-2.5 py-1.5 ${node.style === st ? "bg-violet-500/15 text-violet-700 dark:text-violet-300" : "muted"}`}>
                  {st === "buttons" ? `أزرار تحت الرسالة (حتى ${MENU_LIMITS.buttons - (node.link ? 1 : 0)})` : `أزرار سريعة (حتى ${MENU_LIMITS.quick})`}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            {node.children.map((c, i) => (
              <OptionItem key={c.key} c={c} first={i === 0} last={i === node.children.length - 1} taps={taps} depth={depth}
                onMove={(d) => move(i, d)} onRemove={() => setChild(i, null)} onChange={(n) => setChild(i, n)} />
            ))}
          </div>
          {canNest && (
            <button
              type="button"
              className="btn btn-ghost mt-2 w-full text-sm"
              disabled={node.children.length >= max}
              onClick={() => onChange({ ...node, children: [...node.children, { key: newKey(), label: "", text: "", link: null, style: "buttons", children: [] }] })}
            >
              <Icon name="plus" size={15} />{node.children.length >= max ? `وصلت الحد (${max})${node.style === "buttons" ? " — اختر «أزرار سريعة» لأكثر" : ""}` : "إضافة خيار"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** One option, folded or open (opens by itself when just added, and stays open while you type). */
function OptionItem({ c, first, last, taps, depth, onMove, onRemove, onChange }: { c: MenuNode; first: boolean; last: boolean; taps: Record<string, number>; depth: number; onMove: (d: -1 | 1) => void; onRemove: () => void; onChange: (n: MenuNode) => void }) {
  const [open, setOpen] = useState(!c.label);
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-right" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="chev" size={14} className={`shrink-0 transition ${open ? "rotate-180" : ""}`} />
          <b className="min-w-0 flex-1 truncate text-sm">{c.label || "خيار جديد"}</b>
          {taps[c.key] ? <span className="chip surface-2 muted !py-0 text-[10.5px]">{taps[c.key]} ضغطة</span> : null}
          {c.children.length > 0 && <span className="muted text-[11px]">{c.children.length} فرعية</span>}
        </button>
        <button type="button" className="btn btn-ghost min-h-8 px-2 text-xs" disabled={first} aria-label="لفوق" onClick={() => onMove(-1)}>▲</button>
        <button type="button" className="btn btn-ghost min-h-8 px-2 text-xs" disabled={last} aria-label="لتحت" onClick={() => onMove(1)}>▼</button>
        <button type="button" className="btn btn-ghost min-h-8 px-2 text-xs text-red-600" onClick={onRemove}>حذف</button>
      </div>
      {open && (
        <div className="border-t border-[var(--border)] p-3">
          <NodeEditor node={c} depth={depth + 1} taps={taps} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

/** How the menu message looks: the text, a link button, and the options as buttons or chips. */
function Preview({ root }: { root: MenuNode }) {
  const bubble = "rounded-2xl bg-[#262a33] px-3.5 py-2.5 text-sm leading-relaxed text-white";
  return (
    <div className="rounded-2xl bg-[#0b0d12] p-3" dir="rtl">
      <div className="max-w-[85%] space-y-1.5">
        <div className={`${bubble} whitespace-pre-wrap break-words`}>{root.text || "…"}</div>
        {root.style === "buttons" && (
          <>
            {root.link && <div className="rounded-xl bg-[#1c1f26] px-3 py-2.5 text-center text-sm font-semibold text-white">{root.link.title || "الرابط"}</div>}
            {root.children.map((c) => <div key={c.key} className="rounded-xl bg-[#1c1f26] px-3 py-2.5 text-center text-sm font-semibold text-white">{c.label || "خيار"}</div>)}
          </>
        )}
        {root.style === "quick" && root.link && <div className="text-xs text-sky-400 underline" dir="ltr">{root.link.url}</div>}
      </div>
      {root.style === "quick" && root.children.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {root.children.map((c) => <span key={c.key} className="rounded-full border border-white/25 px-3 py-1.5 text-xs font-semibold text-white">{c.label || "خيار"}</span>)}
        </div>
      )}
    </div>
  );
}
