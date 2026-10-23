import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "./Icon";
import { Alert, Field, Modal, Spinner, toast } from "./ui";
import { emptyMenu, keywordsProblem, menuProblem, MENU_LIMITS, newKey, type DmMenu, type MenuNode } from "../../shared/menu";

/** Buttons under a message hold 3 (a link takes one); with more, they go out as quick replies (up to 13). */
const withStyles = (n: MenuNode): MenuNode => ({
  ...n,
  style: n.children.length + (n.link ? 1 : 0) > MENU_LIMITS.buttons ? "quick" : "buttons",
  children: n.children.map(withStyles),
});
const blankOption = (): MenuNode => ({ key: newKey(), label: "", text: "", link: null, style: "buttons", children: [] });

/**
 * «القائمة التلقائية» in one simple screen: when it is sent (chosen words, or any message), the first message, and
 * its buttons — each button replies with its own text, an optional link and its own buttons, a few levels deep.
 */
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
  const check = (m: DmMenu) => menuProblem(withStyles(m.root)) ?? keywordsProblem(m);
  const problem = check(menu);
  const save = async (next = menu, done = "تم الحفظ ✅") => {
    const p = check(next);
    if (p) return toast(p, "bad");
    setBusy(true);
    try {
      const body = { ...next, root: withStyles(next.root), ice_breakers: [], persistent: [] };
      await api("/api/dm-menu", { method: "PUT", body });
      setMenu(body);
      setDirty(false);
      toast(done);
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const byWords = menu.trigger === "keywords";
  const canTurnOn = available && menu.root.children.length > 0 && !problem;
  return (
    <div className="space-y-4">
      {!available && (
        <Alert tone="warn">القائمة التلقائية مو ضمن باقتك الحالية. تقدر تجهّزها الحين، والتشغيل يحتاج باقة فيها «القائمة التلقائية» — <a className="font-bold underline" href="#/subscription">اشتراكي</a>.</Alert>
      )}

      <div className={`card flex items-center gap-3 ${menu.enabled ? "ring-1 ring-emerald-400/60" : ""}`}>
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--surface-2)] text-xl">💬</span>
        <div className="min-w-0 flex-1">
          <b className="font-display block text-base">القائمة التلقائية</b>
          <span className={`text-xs font-bold ${menu.enabled ? "text-emerald-600" : "muted"}`}>{menu.enabled ? "● شغّالة" : !menu.root.children.length ? "○ متوقفة — أضف زر واحد على الأقل" : "○ متوقفة"}</span>
        </div>
        <label className="relative inline-flex shrink-0 cursor-pointer items-center">
          <input type="checkbox" className="peer sr-only" checked={menu.enabled} disabled={!menu.enabled && !canTurnOn} onChange={(e) => save({ ...menu, enabled: e.target.checked }, e.target.checked ? "تم تشغيل القائمة ✅" : "تم إيقاف القائمة")} aria-label="تشغيل القائمة التلقائية" />
          <span className="h-7 w-12 rounded-full bg-[var(--border)] transition peer-checked:bg-emerald-500 peer-disabled:opacity-40" />
          <span className="absolute right-1 top-1 h-5 w-5 rounded-full bg-white shadow transition peer-checked:-translate-x-5" />
        </label>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <Step n={1} title="متى توصل القائمة؟">
            <div className="grid grid-cols-2 gap-2">
              {([["keywords", "لما يكتب كلمة أحددها"], ["any", "مع أي رسالة"]] as const).map(([k, l]) => {
                const on = k === "keywords" ? byWords : !byWords;
                return (
                  <button key={k} type="button" onClick={() => update({ ...menu, trigger: k === "keywords" ? "keywords" : menu.trigger === "keywords" ? "daily" : menu.trigger })}
                    className={`rounded-xl border px-3 py-3 text-sm font-bold ${on ? "border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300" : "border-[var(--border)]"}`}>{l}</button>
                );
              })}
            </div>
            {byWords ? (
              <WordsInput words={menu.keywords ?? []} onChange={(keywords) => update({ ...menu, keywords })} />
            ) : (
              <select className="input mt-3" value={menu.trigger} onChange={(e) => update({ ...menu, trigger: e.target.value as DmMenu["trigger"] })} aria-label="كم مرة">
                <option value="daily">مرة وحدة كل 24 ساعة لنفس الشخص</option>
                <option value="first">أول رسالة من الشخص فقط</option>
                <option value="every">مع كل رسالة</option>
              </select>
            )}
          </Step>

          <Step n={2} title="الرسالة الأولى">
            <textarea className="input min-h-[5.5rem]" maxLength={MENU_LIMITS.text} value={menu.root.text} onChange={(e) => update({ ...menu, root: { ...menu.root, text: e.target.value } })} placeholder="أهلًا 👋 اختر من الأزرار:" aria-label="الرسالة الأولى" />
            <LinkEditor node={menu.root} onChange={(root) => update({ ...menu, root })} />
          </Step>

          <Step n={3} title="الأزرار تحت الرسالة">
            <Buttons node={menu.root} depth={0} taps={taps} onChange={(root) => update({ ...menu, root })} />
          </Step>

          <details className="card">
            <summary className="cursor-pointer text-sm font-bold">إعدادات إضافية</summary>
            <div className="mt-3">
              <Field label="إذا رديت على الشخص بنفسك" hint="القائمة ما ترسل له هالمدة عشان ما تقاطع محادثتك">
                <select className="input" value={menu.pause_hours} onChange={(e) => update({ ...menu, pause_hours: Number(e.target.value) })}>
                  {[0, 2, 6, 12, 24, 48, 72].map((h) => <option key={h} value={h}>{h === 0 ? "لا تتوقف" : `توقف ${h} ساعة`}</option>)}
                </select>
              </Field>
            </div>
          </details>
        </div>
        <div className="xl:sticky xl:top-4 xl:self-start">
          <div className="muted mb-1.5 text-xs font-bold">المعاينة — اضغط الأزرار تشوف الرد</div>
          <Preview root={menu.root} />
        </div>
      </div>

      <p className="muted text-xs">كل رسالة يرسلها النظام تنحسب من رسائل باقتك، والضغط على الأزرار نفسه ما ينحسب. النظام يرد فقط على اللي راسلك أول.</p>
      {(dirty || problem) && (
        <div className="sticky bottom-20 z-10 flex items-center gap-3 rounded-2xl border border-violet-300 bg-[var(--surface)] p-3 shadow-lg lg:bottom-4 dark:border-violet-800">
          <button className="btn btn-primary" disabled={busy || !!problem || !dirty} onClick={() => save()}>{busy ? "…" : "حفظ"}</button>
          <span className={`text-xs ${problem ? "text-red-600" : "muted"}`}>{problem ?? "فيه تعديلات ما انحفظت"}</span>
        </div>
      )}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <div className="mb-3 flex items-center gap-2">
        <span className="grad flex h-7 w-7 items-center justify-center rounded-full text-sm font-extrabold text-white">{n}</span>
        <b className="font-display text-base">{title}</b>
      </div>
      {children}
    </section>
  );
}

/** Trigger words as chips: type a word and press Enter (or a comma). */
function WordsInput({ words, onChange }: { words: string[]; onChange: (w: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const w = raw.split(/[,،\n]+/).map((x) => x.trim()).filter((x) => x && !words.includes(x));
    if (w.length) onChange([...words, ...w].slice(0, MENU_LIMITS.keywords));
    setDraft("");
  };
  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-1.5">
        {words.map((w) => (
          <span key={w} className="chip bg-violet-500/10 text-violet-700 dark:text-violet-300">
            {w}
            <button type="button" aria-label={`حذف ${w}`} className="ms-1 font-bold" onClick={() => onChange(words.filter((x) => x !== w))}>×</button>
          </span>
        ))}
      </div>
      <input
        className="input mt-2"
        value={draft}
        maxLength={MENU_LIMITS.keyword}
        onChange={(e) => (/[,،]/.test(e.target.value) ? add(e.target.value) : setDraft(e.target.value))}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(draft); } }}
        onBlur={() => draft.trim() && add(draft)}
        placeholder="اكتب كلمة واضغط Enter — مثل: السعر، التغطية"
        aria-label="كلمة جديدة"
      />
      <p className="muted mt-1 text-[11px]">إذا رسالة الشخص فيها وحدة من الكلمات، توصله القائمة (كل مرة يكتبها).</p>
    </div>
  );
}

/** «+ رابط» or the link's title and address. */
function LinkEditor({ node, onChange }: { node: MenuNode; onChange: (n: MenuNode) => void }) {
  if (!node.link)
    return <button type="button" className="mt-2 text-xs font-semibold text-violet-700 underline dark:text-violet-300" onClick={() => onChange({ ...node, link: { title: "افتح الرابط", url: "https://" } })}>+ إضافة رابط</button>;
  return (
    <div className="mt-2 grid gap-2 rounded-xl border border-[var(--border)] p-2.5 sm:grid-cols-[1fr_1.6fr_auto]">
      <input className="input" maxLength={MENU_LIMITS.label} value={node.link.title} onChange={(e) => onChange({ ...node, link: { ...node.link!, title: e.target.value } })} aria-label="عنوان زر الرابط" placeholder="عنوان زر الرابط" />
      <input className="input" dir="ltr" value={node.link.url} onChange={(e) => onChange({ ...node, link: { ...node.link!, url: e.target.value.trim() } })} aria-label="الرابط" placeholder="https://" />
      <button type="button" className="btn btn-ghost min-h-10 text-xs text-red-600" onClick={() => onChange({ ...node, link: null })}>حذف الرابط</button>
    </div>
  );
}

/** The buttons of a message, each with its reply, and «+ زر». */
function Buttons({ node, depth, taps, onChange }: { node: MenuNode; depth: number; taps: Record<string, number>; onChange: (n: MenuNode) => void }) {
  const max = MENU_LIMITS.quick;
  const set = (i: number, c: MenuNode | null) => onChange({ ...node, children: c ? node.children.map((x, j) => (j === i ? c : x)) : node.children.filter((_, j) => j !== i) });
  const move = (i: number, d: -1 | 1) => {
    const ch = [...node.children];
    [ch[i], ch[i + d]] = [ch[i + d], ch[i]];
    onChange({ ...node, children: ch });
  };
  return (
    <div className="space-y-2">
      {node.children.map((c, i) => (
        <ButtonCard key={c.key} c={c} depth={depth} taps={taps} first={i === 0} last={i === node.children.length - 1} onMove={(d) => move(i, d)} onRemove={() => set(i, null)} onChange={(n) => set(i, n)} />
      ))}
      {node.children.length < max && (
        <button type="button" className="btn btn-ghost w-full text-sm" onClick={() => onChange({ ...node, children: [...node.children, blankOption()] })}>
          <Icon name="plus" size={15} />{depth === 0 ? "إضافة زر" : "إضافة زر تحت هذا الرد"}
        </button>
      )}
    </div>
  );
}

/** One button: its title, and what it sends when tapped (text, link, its own buttons). */
function ButtonCard({ c, depth, taps, first, last, onMove, onRemove, onChange }: { c: MenuNode; depth: number; taps: Record<string, number>; first: boolean; last: boolean; onMove: (d: -1 | 1) => void; onRemove: () => void; onChange: (n: MenuNode) => void }) {
  const [open, setOpen] = useState(!c.label);
  const canNest = depth + 1 < MENU_LIMITS.depth;
  return (
    <div className={`rounded-2xl border border-[var(--border)] ${depth % 2 ? "bg-[var(--surface)]" : "bg-[var(--surface-2)]"}`}>
      <div className="flex items-center gap-1.5 p-2">
        <input className="input min-w-0 flex-1 font-bold" maxLength={MENU_LIMITS.label} value={c.label} onChange={(e) => onChange({ ...c, label: e.target.value })} placeholder="عنوان الزر — مثل: الأسعار" aria-label="عنوان الزر" />
        {taps[c.key] ? <span className="chip surface-2 muted shrink-0 !py-0 text-[10.5px]">{taps[c.key]} ضغطة</span> : null}
        <button type="button" className="btn btn-ghost min-h-9 shrink-0 px-2 text-xs" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "إخفاء" : "الرد"}<Icon name="chev" size={13} className={`transition ${open ? "rotate-180" : ""}`} /></button>
        <button type="button" className="btn btn-ghost min-h-9 shrink-0 px-2 text-xs" disabled={first} aria-label="لفوق" onClick={() => onMove(-1)}>▲</button>
        <button type="button" className="btn btn-ghost min-h-9 shrink-0 px-2 text-xs" disabled={last} aria-label="لتحت" onClick={() => onMove(1)}>▼</button>
        <button type="button" className="btn btn-ghost min-h-9 shrink-0 px-2 text-xs text-red-600" aria-label="حذف الزر" onClick={onRemove}>✕</button>
      </div>
      {open && (
        <div className="space-y-2 border-t border-[var(--border)] p-3">
          <div className="muted text-xs font-bold">لما يضغط «{c.label || "الزر"}» يوصله:</div>
          <textarea className="input min-h-[4.5rem]" maxLength={MENU_LIMITS.text} value={c.text} onChange={(e) => onChange({ ...c, text: e.target.value })} placeholder="مثل: السعر 210 ريال وتدفع 110 فقط" aria-label="الرد" />
          <LinkEditor node={c} onChange={onChange} />
          {canNest && (
            <div className="border-s-2 border-violet-300 ps-3 dark:border-violet-800">
              <Buttons node={c} depth={depth + 1} taps={taps} onChange={onChange} />
            </div>
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

/** The message as it looks in Instagram; tapping a button shows its reply (with «رجوع»). */
function Preview({ root }: { root: MenuNode }) {
  const [path, setPath] = useState<string[]>([]);
  let node = root;
  for (const k of path) node = node.children.find((c) => c.key === k) ?? node;
  const n = withStyles(node);
  const bubble = "rounded-2xl bg-[#262a33] px-3.5 py-2.5 text-sm leading-relaxed text-white";
  const btn = "block w-full rounded-xl bg-[#1c1f26] px-3 py-2.5 text-center text-sm font-semibold text-white";
  return (
    <div className="rounded-2xl bg-[#0b0d12] p-3" dir="rtl">
      {path.length > 0 && <button type="button" className="mb-2 text-xs font-bold text-sky-400" onClick={() => setPath(path.slice(0, -1))}>‹ رجوع</button>}
      <div className="max-w-[88%] space-y-1.5">
        <div className={`${bubble} whitespace-pre-wrap break-words`}>{n.text || "…"}</div>
        {n.style === "buttons" && (
          <>
            {n.link && <div className={btn}>{n.link.title || "الرابط"} ↗</div>}
            {n.children.map((c) => <button type="button" key={c.key} className={btn} onClick={() => setPath([...path, c.key])}>{c.label || "زر"}</button>)}
          </>
        )}
        {n.style === "quick" && n.link && <div className="text-xs text-sky-400 underline" dir="ltr">{n.link.url}</div>}
      </div>
      {n.style === "quick" && n.children.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {n.children.map((c) => <button type="button" key={c.key} className="rounded-full border border-white/25 px-3 py-1.5 text-xs font-semibold text-white" onClick={() => setPath([...path, c.key])}>{c.label || "زر"}</button>)}
        </div>
      )}
    </div>
  );
}
