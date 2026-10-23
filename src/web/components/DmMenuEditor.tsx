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

/** The chain of nodes from the root down to `key` (empty when not found). */
function pathTo(root: MenuNode, key: string): MenuNode[] {
  if (root.key === key) return [root];
  for (const c of root.children) {
    const p = pathTo(c, key);
    if (p.length) return [root, ...p];
  }
  return [];
}
/** A copy of the tree with the node `key` replaced (or removed when `next` is null). */
function replaceNode(root: MenuNode, key: string, next: MenuNode | null): MenuNode {
  return { ...root, children: root.children.flatMap((c) => (c.key === key ? (next ? [next] : []) : [replaceNode(c, key, next)])) };
}

/**
 * «القائمة التلقائية» as a tree (like an organisation chart): the first message on top, its buttons below it, and each
 * button's own buttons below that. Tapping a box opens it in the side panel to edit it, add a button under it or delete it.
 */
export function DmMenuEditor() {
  const [menu, setMenu] = useState<DmMenu | null>(null);
  const [available, setAvailable] = useState(true);
  const [taps, setTaps] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
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
  const selKey = sel && pathTo(menu.root, sel).length ? sel : menu.root.key;
  const path = pathTo(menu.root, selKey);
  const node = path[path.length - 1];
  const depth = path.length - 1;
  const setNode = (n: MenuNode) => update({ ...menu, root: n.key === menu.root.key ? n : replaceNode(menu.root, n.key, n) });
  const addChild = (parent: MenuNode) => {
    if (parent.children.length >= MENU_LIMITS.quick) return toast(`الحد ${MENU_LIMITS.quick} أزرار`, "bad");
    const c = blankOption();
    setNode({ ...parent, children: [...parent.children, c] });
    setSel(c.key);
  };
  const remove = (n: MenuNode) => {
    update({ ...menu, root: replaceNode(menu.root, n.key, null) });
    setSel(path[path.length - 2]?.key ?? null);
  };
  const move = (d: -1 | 1) => {
    const parent = path[path.length - 2];
    if (!parent) return;
    const i = parent.children.findIndex((c) => c.key === node.key);
    const j = i + d;
    if (j < 0 || j >= parent.children.length) return;
    const ch = [...parent.children];
    [ch[i], ch[j]] = [ch[j], ch[i]];
    setNode({ ...parent, children: ch });
  };
  const canTurnOn = available && menu.root.children.length > 0 && !problem;
  const byWords = menu.trigger === "keywords";
  return (
    <div className="space-y-4">
      {!available && (
        <Alert tone="warn">القائمة التلقائية مو ضمن باقتك الحالية. تقدر تجهّزها الحين، والتشغيل يحتاج باقة فيها «القائمة التلقائية» — <a className="font-bold underline" href="#/subscription">اشتراكي</a>.</Alert>
      )}
      <div className={`card flex items-center gap-3 p-4 ${menu.enabled ? "ring-1 ring-emerald-400/60" : ""}`}>
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--surface-2)] text-xl">💬</span>
        <div className="min-w-0 flex-1">
          <b className="font-display block text-base">القائمة التلقائية</b>
          <span className={`text-xs font-bold ${menu.enabled ? "text-emerald-600" : "muted"}`}>
            {menu.enabled ? "● شغّالة" : !menu.root.children.length ? "○ متوقفة — أضف زر واحد على الأقل" : "○ متوقفة"}
            {" · "}{byWords ? `لما يكتب: ${(menu.keywords ?? []).slice(0, 3).join("، ") || "—"}` : menu.trigger === "every" ? "مع كل رسالة" : menu.trigger === "first" ? "أول رسالة فقط" : "مرة كل 24 ساعة"}
          </span>
        </div>
        <label className="relative inline-flex shrink-0 cursor-pointer items-center">
          <input type="checkbox" className="peer sr-only" checked={menu.enabled} disabled={!menu.enabled && !canTurnOn} onChange={(e) => save({ ...menu, enabled: e.target.checked }, e.target.checked ? "تم تشغيل القائمة ✅" : "تم إيقاف القائمة")} aria-label="تشغيل القائمة التلقائية" />
          <span className="h-7 w-12 rounded-full bg-[var(--border)] transition peer-checked:bg-emerald-500 peer-disabled:opacity-40" />
          <span className="absolute right-1 top-1 h-5 w-5 rounded-full bg-white shadow transition peer-checked:-translate-x-5" />
        </label>
      </div>

      <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        {/* side panel: the selected box */}
        <div id="menu-panel" className="card scroll-mt-20 space-y-3 p-4 lg:sticky lg:top-4 lg:self-start">
          <b className="font-display block text-base">✏️ {depth === 0 ? "الرسالة الأولى" : `تعديل: «${node.label || "زر جديد"}»`}</b>
          {depth > 0 && (
            <Field label="عنوان الزر" hint={`${node.label.length}/${MENU_LIMITS.label}`}>
              <input className="input" autoFocus={!node.label} maxLength={MENU_LIMITS.label} value={node.label} onChange={(e) => setNode({ ...node, label: e.target.value })} placeholder="مثل: الأسعار" />
            </Field>
          )}
          <Field label={depth === 0 ? "نص الرسالة" : "لما يضغطه يوصله"}>
            <textarea className="input min-h-[5.5rem]" maxLength={MENU_LIMITS.text} value={node.text} onChange={(e) => setNode({ ...node, text: e.target.value })} placeholder={depth === 0 ? "أهلًا 👋 اختر من الأزرار:" : "مثل: السعر 210 ريال وتدفع 110 فقط"} />
          </Field>
          <LinkEditor node={node} onChange={setNode} />
          <div className="flex flex-wrap gap-2">
            {depth + 1 < MENU_LIMITS.depth && <button type="button" className="btn btn-primary min-h-9 text-sm" onClick={() => addChild(node)}><Icon name="plus" size={15} />زر تحته</button>}
            {depth > 0 && (
              <>
                <button type="button" className="btn btn-ghost min-h-9 px-3 text-sm" onClick={() => move(-1)} title="قبل">→</button>
                <button type="button" className="btn btn-ghost min-h-9 px-3 text-sm" onClick={() => move(1)} title="بعد">←</button>
                <button type="button" className="btn btn-ghost min-h-9 text-sm text-red-600" onClick={() => remove(node)}>حذف{node.children.length ? " مع أزراره" : ""}</button>
              </>
            )}
          </div>
          {taps[node.key] ? <p className="muted text-xs">انضغط {taps[node.key]} مرة</p> : null}
          {depth === 0 && (
            <div className="space-y-3 border-t border-[var(--border)] pt-3">
              <b className="text-sm">متى توصل القائمة؟</b>
              <div className="grid grid-cols-2 gap-2">
                {([["keywords", "لما يكتب كلمة"], ["any", "مع أي رسالة"]] as const).map(([k, l]) => {
                  const on = k === "keywords" ? byWords : !byWords;
                  return (
                    <button key={k} type="button" onClick={() => update({ ...menu, trigger: k === "keywords" ? "keywords" : byWords ? "daily" : menu.trigger })}
                      className={`rounded-xl border px-2 py-2.5 text-sm font-bold ${on ? "border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300" : "border-[var(--border)]"}`}>{l}</button>
                  );
                })}
              </div>
              {byWords ? (
                <WordsInput words={menu.keywords ?? []} onChange={(keywords) => update({ ...menu, keywords })} />
              ) : (
                <select className="input" value={menu.trigger} onChange={(e) => update({ ...menu, trigger: e.target.value as DmMenu["trigger"] })} aria-label="كم مرة">
                  <option value="daily">مرة وحدة كل 24 ساعة لنفس الشخص</option>
                  <option value="first">أول رسالة من الشخص فقط</option>
                  <option value="every">مع كل رسالة</option>
                </select>
              )}
              <Field label="إذا رديت على الشخص بنفسك" hint="القائمة ما ترسل له هالمدة عشان ما تقاطع محادثتك">
                <select className="input" value={menu.pause_hours} onChange={(e) => update({ ...menu, pause_hours: Number(e.target.value) })}>
                  {[0, 2, 6, 12, 24, 48, 72].map((h) => <option key={h} value={h}>{h === 0 ? "لا تتوقف" : `توقف ${h} ساعة`}</option>)}
                </select>
              </Field>
            </div>
          )}
        </div>

        {/* the tree */}
        <div className="card min-w-0 p-4">
          <p className="muted mb-3 text-xs">اضغط أي مربع لتعديله — «+» يضيف زر تحته.<span className="hidden sm:inline"> إذا كبرت الشجرة اسحبها يمين ويسار.</span></p>
          <div className="hidden overflow-x-auto sm:block">
            <div className="mx-auto w-max px-2 pb-4">
              <TreeNode node={menu.root} depth={0} selected={selKey} taps={taps} onSelect={setSel} onAdd={addChild} />
            </div>
          </div>
          <div className="sm:hidden">
            <OutlineNode node={menu.root} depth={0} selected={selKey} onSelect={(k) => { setSel(k); document.getElementById("menu-panel")?.scrollIntoView({ behavior: "smooth" }); }} onAdd={(n) => { addChild(n); document.getElementById("menu-panel")?.scrollIntoView({ behavior: "smooth" }); }} />
          </div>
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

const LINE = "border-violet-300 dark:border-violet-800";

/** One box of the chart with its children below, joined by lines (first child on the right). */
function TreeNode({ node, depth, selected, taps, onSelect, onAdd }: { node: MenuNode; depth: number; selected: string; taps: Record<string, number>; onSelect: (k: string) => void; onAdd: (n: MenuNode) => void }) {
  const on = node.key === selected;
  const canAdd = depth + 1 < MENU_LIMITS.depth && node.children.length < MENU_LIMITS.quick;
  return (
    <div className="flex flex-col items-center">
      <div className="relative">
        <button
          type="button"
          onClick={(e) => { onSelect(node.key); e.currentTarget.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }); }}
          className={`w-36 rounded-2xl border-2 bg-[var(--surface)] px-3 py-2.5 text-center shadow-sm transition ${on ? "border-emerald-500 ring-4 ring-emerald-500/15" : depth === 0 ? "border-violet-500 bg-violet-500/5" : "border-[var(--border)] hover:border-violet-300"}`}
        >
          <b className="block truncate text-sm">{depth === 0 ? "💬 الرسالة الأولى" : node.label || "زر جديد"}</b>
          <span className="muted block truncate text-[11px]">{node.text || "اكتب الرد…"}{node.link ? " · 🔗" : ""}</span>
          {taps[node.key] ? <span className="mt-0.5 block text-[10px] font-bold text-emerald-600">{taps[node.key]} ضغطة</span> : null}
        </button>
        {canAdd && (
          <button type="button" onClick={() => onAdd(node)} aria-label="إضافة زر تحته" className="absolute -bottom-3 left-1/2 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full border border-violet-300 bg-[var(--surface)] text-sm font-bold text-violet-600 shadow hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300">+</button>
        )}
      </div>
      {node.children.length > 0 && (
        <>
          <div className={`h-5 border-l-2 ${LINE}`} />
          <div className="flex gap-2">
            {node.children.map((c, i) => {
              const first = i === 0;
              const last = i === node.children.length - 1;
              return (
                <div key={c.key} className="relative flex flex-col items-center pt-5">
                  {/* RTL: the first child is on the right (no line to its right), the last on the left (no line to its left) */}
                  {!first && <div className={`absolute top-0 border-t-2 ${LINE}`} style={{ left: "50%", right: "-0.25rem" }} />}
                  {!last && <div className={`absolute top-0 border-t-2 ${LINE}`} style={{ left: "-0.25rem", right: "50%" }} />}
                  <div className={`absolute left-1/2 top-0 h-5 border-l-2 ${LINE}`} />
                  <TreeNode node={c} depth={depth + 1} selected={selected} taps={taps} onSelect={onSelect} onAdd={onAdd} />
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** The same tree as an indented list, for phones. */
function OutlineNode({ node, depth, selected, onSelect, onAdd }: { node: MenuNode; depth: number; selected: string; onSelect: (k: string) => void; onAdd: (n: MenuNode) => void }) {
  const on = node.key === selected;
  return (
    <div className={depth ? `border-s-2 ps-3 ${LINE}` : ""}>
      <div className="flex items-center gap-2 py-1">
        <button type="button" onClick={() => onSelect(node.key)} className={`min-w-0 flex-1 rounded-xl border-2 px-3 py-2 text-right ${on ? "border-emerald-500" : depth === 0 ? "border-violet-500" : "border-[var(--border)]"}`}>
          <b className="block truncate text-sm">{depth === 0 ? "💬 الرسالة الأولى" : node.label || "زر جديد"}</b>
          <span className="muted block truncate text-[11px]">{node.text || "اكتب الرد…"}</span>
        </button>
        {depth + 1 < MENU_LIMITS.depth && <button type="button" onClick={() => onAdd(node)} aria-label="إضافة زر تحته" className="btn btn-ghost min-h-9 shrink-0 px-3 text-sm">+</button>}
      </div>
      {node.children.map((c) => <OutlineNode key={c.key} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} onAdd={onAdd} />)}
    </div>
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

