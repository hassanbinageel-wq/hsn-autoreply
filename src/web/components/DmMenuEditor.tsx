import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "./Icon";
import { Alert, Field, InfoDot, Modal, Spinner, toast } from "./ui";
import { emptyMenu, keywordsProblem, maxOptions, menuProblem, MENU_LIMITS, newKey, TRIGGER_LABELS, type DmMenu, type MenuNode } from "../../shared/menu";

const splitWords = (v: string) => v.split(/[\n,،]+/).map((w) => w.trim()).filter(Boolean);

/**
 * «القائمة التلقائية»: a message with options sent to whoever writes (or only to messages with chosen words);
 * every option replies with its own content, an optional link and its own options, several levels deep.
 */
export function DmMenuEditor() {
  const [menu, setMenu] = useState<DmMenu | null>(null);
  const [available, setAvailable] = useState(true);
  const [taps, setTaps] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState<"auto" | null>(null);
  const [kwText, setKwText] = useState("");
  useEffect(() => {
    api<{ menu: DmMenu; available: boolean; taps: Record<string, number> }>("/api/dm-menu")
      .then((r) => { setMenu(r.menu ?? emptyMenu()); setKwText((r.menu?.keywords ?? []).join("، ")); setAvailable(r.available); setTaps(r.taps); })
      .catch((e) => toast(e.message, "bad"));
  }, []);
  if (!menu) return <Spinner />;
  const update = (m: DmMenu) => { setMenu(m); setDirty(true); };
  const problem = menuProblem(menu.root) ?? keywordsProblem(menu);
  const save = async (next = menu, done = "تم الحفظ ✅") => {
    const p = menuProblem(next.root) ?? keywordsProblem(next);
    if (p) return toast(p, "bad");
    setBusy(true);
    try {
      await api("/api/dm-menu", { method: "PUT", body: { ...next, ice_breakers: [], persistent: [] } });
      setMenu(next);
      setDirty(false);
      toast(done);
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const onOff = (on: boolean, what: string) => (on ? `تم تشغيل ${what} ✅` : `تم إيقاف ${what}`);
  return (
    <div className="space-y-4">
      {!available && (
        <Alert tone="warn">
          القوائم مو ضمن باقتك الحالية. تقدر تجهّزها الحين، والتشغيل يحتاج باقة فيها «القائمة التلقائية» — <a className="font-bold underline" href="#/subscription">اشتراكي</a>.
        </Alert>
      )}

      <Section
        icon="💬"
        title="القائمة التلقائية"
        desc="رسالة بخيارات توصل للي يراسلك، وكل خيار يرد برد تكتبه."
        summary={`${menu.root.children.length} خيارات · ${menu.trigger === "keywords" ? `الكلمات: ${(menu.keywords ?? []).slice(0, 4).join("، ") || "—"}` : TRIGGER_LABELS[menu.trigger]}`}
        on={menu.enabled}
        canTurnOn={available && menu.root.children.length > 0}
        offHint={!menu.root.children.length ? "أضف خيار واحد على الأقل" : undefined}
        expanded={open === "auto"}
        onExpand={() => setOpen(open === "auto" ? null : "auto")}
        onToggle={(v) => save({ ...menu, enabled: v }, onOff(v, "القائمة التلقائية"))}
      >
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="متى تُرسل؟">
                <select className="input" value={menu.trigger} onChange={(e) => update({ ...menu, trigger: e.target.value as DmMenu["trigger"] })}>
                  {(Object.keys(TRIGGER_LABELS) as Array<DmMenu["trigger"]>).map((k) => <option key={k} value={k}>{TRIGGER_LABELS[k]}</option>)}
                </select>
              </Field>
              {menu.trigger === "keywords" && (
                <div className="sm:col-span-2"><Field label="الكلمات اللي ترسل القائمة" hint="افصل بينها بفاصلة أو سطر جديد — إذا رسالة الشخص فيها وحدة منها توصله القائمة (كل مرة)">
                  <textarea
                    className="input min-h-16"
                    value={kwText}
                    onChange={(e) => { setKwText(e.target.value); update({ ...menu, keywords: splitWords(e.target.value) }); }}
                    placeholder="السعر، الأسعار، التغطية، الفروع"
                  />
                </Field></div>
              )}
              <Field label={<span className="inline-flex items-center gap-1">لما ترد بنفسك <InfoDot text="إذا رديت على شخص بيدك (من صندوق الرسائل أو من تطبيق إنستقرام)، القائمة ما ترسل له طول هالمدة عشان ما تقاطع محادثتك." /></span>}>
                <select className="input" value={menu.pause_hours} onChange={(e) => update({ ...menu, pause_hours: Number(e.target.value) })}>
                  {[0, 2, 6, 12, 24, 48, 72].map((h) => <option key={h} value={h}>{h === 0 ? "لا تتوقف" : `توقف ${h} ساعة`}</option>)}
                </select>
              </Field>
            </div>
            <NodeEditor node={menu.root} depth={0} taps={taps} onChange={(root) => update({ ...menu, root })} />
          </div>
          <div className="xl:sticky xl:top-4 xl:self-start">
            <div className="muted mb-1.5 text-xs font-bold">المعاينة</div>
            <Preview root={menu.root} />
          </div>
        </div>
      </Section>

      <p className="muted text-xs">كل رسالة يرسلها النظام تنحسب من رسائل باقتك — الضغط على الأزرار نفسه ما ينحسب. النظام يرد فقط على اللي راسلك أول.</p>
      {(dirty || problem) && (
        <div className="sticky bottom-20 z-10 flex items-center gap-3 rounded-2xl border border-violet-300 bg-[var(--surface)] p-3 shadow-lg lg:bottom-4 dark:border-violet-800">
          <button className="btn btn-primary" disabled={busy || !!problem || !dirty} onClick={() => save()}>{busy ? "…" : "حفظ التعديلات"}</button>
          <span className={`text-xs ${problem ? "text-red-600" : "muted"}`}>{problem ?? "فيه تعديلات ما انحفظت"}</span>
        </div>
      )}
    </div>
  );
}

/** One section: icon, title, a short line, the summary, its own switch; opens to edit. */
function Section({ icon, title, desc, summary, on, canTurnOn, offHint, expanded, onExpand, onToggle, children }: {
  icon: string; title: string; desc: string; summary: string; on: boolean; canTurnOn: boolean; offHint?: string; expanded: boolean; onExpand: () => void; onToggle: (v: boolean) => void; children: React.ReactNode;
}) {
  return (
    <section className={`card overflow-hidden p-0 ${on ? "ring-1 ring-emerald-400/50" : ""}`}>
      <div className="flex items-center gap-3 px-4 py-3.5">
        <button type="button" onClick={onExpand} aria-expanded={expanded} className="flex min-w-0 flex-1 items-center gap-3 text-right">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--surface-2)] text-xl">{icon}</span>
          <span className="min-w-0 flex-1">
            <b className="font-display block text-base">{title}</b>
            <span className="muted block truncate text-xs">{desc}</span>
            <span className={`mt-0.5 block text-[11px] font-bold ${on ? "text-emerald-600" : "muted"}`}>{on ? "● شغّالة" : "○ متوقفة"} · {summary}</span>
          </span>
          <Icon name="chev" size={16} className={`shrink-0 transition ${expanded ? "rotate-180" : ""}`} />
        </button>
        <label className="relative inline-flex shrink-0 cursor-pointer items-center" title={!on && !canTurnOn ? offHint : undefined}>
          <input type="checkbox" className="peer sr-only" checked={on} disabled={!on && !canTurnOn} onChange={(e) => onToggle(e.target.checked)} aria-label={`تشغيل ${title}`} />
          <span className="h-7 w-12 rounded-full bg-[var(--border)] transition peer-checked:bg-emerald-500 peer-disabled:opacity-40" />
          <span className="absolute right-1 top-1 h-5 w-5 rounded-full bg-white shadow transition peer-checked:-translate-x-5" />
        </label>
      </div>
      {!on && !canTurnOn && offHint && !expanded && <p className="muted -mt-1 px-4 pb-3 text-[11px]">للتشغيل: {offHint} (افتح القسم)</p>}
      {expanded && <div className="border-t border-[var(--border)] p-4">{children}</div>}
    </section>
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

/** How the automatic menu works, in short. */
export function MenuHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="القائمة التلقائية — كيف تشتغل؟">
      <div className="space-y-3 text-sm leading-relaxed">
        <p>رسالة توصل للشخص لما يراسلك، وتحتها أزرار. كل زر يرسل له محتوى تكتبه أنت، ومعه رابط لو تبي، وتحته أزرار جديدة لخطوة ثانية — وهكذا حتى {MENU_LIMITS.depth} مستويات.</p>
        <ul className="muted list-disc space-y-1 pr-5">
          <li><b>متى توصل:</b> أول رسالة، أو مرة كل 24 ساعة، أو مع كل رسالة، أو <b>لما يكتب كلمة تحددها</b> (مثل «السعر» أو «التغطية»).</li>
          <li><b>الأزرار:</b> حتى 3 أزرار تحت الرسالة (زر الرابط ياخذ واحد منها)، أو حتى 13 زر سريع.</li>
          <li><b>الباقة:</b> كل رسالة يرسلها النظام تنحسب من رسائل باقتك، والضغطة نفسها ما تنحسب.</li>
          <li>النظام يرد فقط على اللي راسلك أول، وخلال 24 ساعة من رسالته (سياسة إنستقرام).</li>
        </ul>
        <button type="button" className="btn btn-primary w-full" onClick={onClose}>فهمت</button>
      </div>
    </Modal>
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
