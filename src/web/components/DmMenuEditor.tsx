import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "./Icon";
import { Alert, Card, Field, InfoDot, Modal, Spinner, Toggle, toast } from "./ui";
import { emptyMenu, extrasProblem, maxOptions, menuProblem, MENU_LIMITS, newKey, TRIGGER_LABELS, type DmMenu, type MenuNode } from "../../shared/menu";

/** «القائمة التلقائية»: whoever writes to the account gets a menu; each option sends its own reply (sub-menus allowed). */
export function DmMenuEditor() {
  const [menu, setMenu] = useState<DmMenu | null>(null);
  const [available, setAvailable] = useState(true);
  const [taps, setTaps] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [help, setHelp] = useState(false);
  const [profile, setProfile] = useState<Array<{ username: string | null; ok: boolean; error?: string; skipped?: boolean }> | null>(null);
  useEffect(() => {
    api<{ menu: DmMenu; available: boolean; taps: Record<string, number> }>("/api/dm-menu")
      .then((r) => { setMenu(r.menu ?? emptyMenu()); setAvailable(r.available); setTaps(r.taps); })
      .catch((e) => toast(e.message, "bad"));
  }, []);
  if (!menu) return <Spinner />;
  const update = (m: DmMenu) => { setMenu(m); setDirty(true); };
  const problem = menuProblem(menu.root) ?? extrasProblem(menu);
  const save = async (next = menu) => {
    const p = menuProblem(next.root) ?? extrasProblem(next);
    if (p) return toast(p, "bad");
    setBusy(true);
    try {
      const r = await api<{ profile?: Array<{ username: string | null; ok: boolean; error?: string; skipped?: boolean }> }>("/api/dm-menu", { method: "PUT", body: next });
      setProfile(r.profile?.filter((x) => !x.skipped) ?? null);
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
        <Card title="رسالة القائمة والخيارات" action={<button type="button" className="btn btn-ghost min-h-9 text-xs" onClick={() => setHelp(true)}>؟ وش الفرق بين القوائم</button>}>
          <NodeEditor node={menu.root} depth={0} taps={taps} onChange={(root) => update({ ...menu, root })} />
        </Card>
        <ExtrasEditor menu={menu} onChange={update} onHelp={() => setHelp(true)} />
        {profile && profile.length > 0 && (
          <Alert tone={profile.every((x) => x.ok) ? "good" : "warn"}>
            {profile.map((x, i) => <div key={i}>{x.username ? `@${x.username}: ` : ""}{x.ok ? "تم تحديث أسئلة البداية والقائمة الثابتة في إنستقرام (قد تتأخر شوي حتى تظهر للمحادثات القديمة)." : `ما تحدّثت أسئلة البداية والقائمة الثابتة: ${x.error}`}</div>)}
          </Alert>
        )}
        <MenuHelp open={help} onClose={() => setHelp(false)} />
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

/** Every option of the menu, with its path (for linking ice breakers / persistent-menu items to an option). */
function flatOptions(root: MenuNode): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  const walk = (n: MenuNode, path: string) => n.children.forEach((c) => { const l = path ? `${path} ← ${c.label || "خيار"}` : c.label || "خيار"; out.push({ key: c.key, label: l }); walk(c, l); });
  walk(root, "");
  return out;
}

/** Ice breakers (questions before the first message) and the persistent menu (always inside the conversation). */
function ExtrasEditor({ menu, onChange, onHelp }: { menu: DmMenu; onChange: (m: DmMenu) => void; onHelp: () => void }) {
  const opts = flatOptions(menu.root);
  const ice = menu.ice_breakers ?? [];
  const pm = menu.persistent ?? [];
  const optSelect = (value: string | undefined, set: (k: string) => void) => (
    <select className="input min-w-0" value={value ?? ""} onChange={(e) => set(e.target.value)} aria-label="الخيار اللي يرد">
      <option value="" disabled>اختر الرد من القائمة…</option>
      {opts.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
    </select>
  );
  return (
    <>
      <Card title={<span className="inline-flex items-center gap-1.5">أسئلة البداية <InfoDot text="حتى 4 أسئلة تظهر للشخص أول ما يفتح محادثة مع حسابك، قبل ما يكتب أي شي (في تطبيق إنستقرام، وفي أول محادثة فقط). يضغط السؤال ويوصله رد الخيار اللي تختاره." /></span>} action={<button type="button" className="btn btn-ghost min-h-9 text-xs" onClick={onHelp}>؟ شرح</button>}>
        {!opts.length ? <p className="muted text-sm">أضف خيارات للقائمة أول، وبعدها تربط كل سؤال بخيار.</p> : (
          <div className="space-y-2">
            {ice.map((q, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1.2fr_1fr_auto]">
                <input className="input" maxLength={MENU_LIMITS.question} value={q.question} onChange={(e) => onChange({ ...menu, ice_breakers: ice.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)) })} aria-label="السؤال" placeholder="مثل: كم سعر التوصيل؟" />
                {optSelect(q.key, (k) => onChange({ ...menu, ice_breakers: ice.map((x, j) => (j === i ? { ...x, key: k } : x)) }))}
                <button type="button" className="btn btn-ghost min-h-10 text-xs text-red-600" onClick={() => onChange({ ...menu, ice_breakers: ice.filter((_, j) => j !== i) })}>حذف</button>
              </div>
            ))}
            <button type="button" className="btn btn-ghost w-full text-sm" disabled={ice.length >= MENU_LIMITS.iceBreakers} onClick={() => onChange({ ...menu, ice_breakers: [...ice, { question: "", key: opts[0].key }] })}>
              <Icon name="plus" size={15} />{ice.length >= MENU_LIMITS.iceBreakers ? `الحد ${MENU_LIMITS.iceBreakers} أسئلة` : "إضافة سؤال"}
            </button>
          </div>
        )}
      </Card>
      <Card title={<span className="inline-flex items-center gap-1.5">القائمة الثابتة <InfoDot text="قائمة دائمة داخل المحادثة، تنفتح من أيقونة جنب خانة الكتابة في أي وقت. كل عنصر يفتح خيار من قائمتك أو رابط." /></span>} action={<button type="button" className="btn btn-ghost min-h-9 text-xs" onClick={onHelp}>؟ شرح</button>}>
        <div className="space-y-2">
          {pm.map((p, i) => {
            const isLink = p.url !== undefined;
            const set = (v: Partial<typeof p> & { url?: string; key?: string }) => onChange({ ...menu, persistent: pm.map((x, j) => (j === i ? v as typeof p : x)) });
            return (
              <div key={i} className="grid gap-2 rounded-xl border border-[var(--border)] p-2.5 sm:grid-cols-[1fr_auto_1.3fr_auto]">
                <input className="input" maxLength={MENU_LIMITS.persistentTitle} value={p.title} onChange={(e) => set({ ...p, title: e.target.value })} aria-label="العنوان" placeholder="العنوان" />
                <select className="input w-auto" value={isLink ? "link" : "option"} onChange={(e) => set(e.target.value === "link" ? { title: p.title, url: "https://" } : { title: p.title, key: opts[0]?.key })} aria-label="النوع">
                  <option value="option">خيار من القائمة</option>
                  <option value="link">رابط</option>
                </select>
                {isLink ? <input className="input" dir="ltr" value={p.url} onChange={(e) => set({ title: p.title, url: e.target.value.trim() })} aria-label="الرابط" /> : optSelect(p.key, (k) => set({ title: p.title, key: k }))}
                <button type="button" className="btn btn-ghost min-h-10 text-xs text-red-600" onClick={() => onChange({ ...menu, persistent: pm.filter((_, j) => j !== i) })}>حذف</button>
              </div>
            );
          })}
          <button type="button" className="btn btn-ghost w-full text-sm" disabled={pm.length >= MENU_LIMITS.persistent} onClick={() => onChange({ ...menu, persistent: [...pm, opts.length ? { title: "", key: opts[0].key } : { title: "", url: "https://" }] })}>
            <Icon name="plus" size={15} />{pm.length >= MENU_LIMITS.persistent ? `الحد ${MENU_LIMITS.persistent} عناصر` : "إضافة عنصر"}
          </button>
        </div>
      </Card>
    </>
  );
}

/** «وش الفرق بين القوائم»: the explanation window (points + comparison table). */
function MenuHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rows: Array<[string, string, string, string]> = [
    ["متى تظهر", "لما يرسل الشخص رسالة", "قبل أول رسالة", "دائمًا داخل المحادثة"],
    ["تُرسل كرسالة؟", "نعم", "لا، تظهر بالواجهة", "لا، تظهر بالواجهة"],
    ["تنحسب من الباقة", "نعم، كل رسالة يرسلها النظام", "الضغطة لا، والرد عليها نعم", "الضغطة لا، والرد عليها نعم"],
    ["مكانها", "الجوال والكمبيوتر", "تطبيق الجوال فقط", "حسب إنستقرام"],
    ["العدد", "حتى 3 أزرار أو 13 زر سريع", "حتى 4 أسئلة", "حتى 5 عناصر"],
  ];
  return (
    <Modal open={open} onClose={onClose} title="القوائم في الرسائل — وش الفرق؟">
      <div className="space-y-4 text-sm leading-relaxed">
        <section>
          <b className="font-display text-base">💬 القائمة التلقائية</b>
          <p className="muted">رسالة فيها خيارات توصل للشخص لما يراسلك (حسب القاعدة اللي تختارها). كل خيار يرسل رد تكتبه أنت، وتقدر تسوي قوائم فرعية.</p>
        </section>
        <section>
          <b className="font-display text-base">❓ أسئلة البداية (Ice Breakers)</b>
          <p className="muted">أسئلة جاهزة تظهر للشخص أول ما يفتح محادثة مع حسابك، قبل ما يكتب أي شي — مثل «كم سعر التوصيل؟» أو «وين موقعكم؟». يضغط السؤال بدل ما يكتب، ويوصله الرد فورًا. تظهر في تطبيق إنستقرام فقط، وفي أول محادثة للشخص مع الحساب.</p>
        </section>
        <section>
          <b className="font-display text-base">📌 القائمة الثابتة (Persistent Menu)</b>
          <p className="muted">قائمة دائمة داخل المحادثة، تنفتح من أيقونة جنب خانة الكتابة. الشخص يوصل للخيارات في أي وقت — حتى بعد أيام — بدون ما تزعجه برسالة.</p>
        </section>
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full min-w-[520px] text-right text-xs">
            <thead className="bg-[var(--surface-2)]">
              <tr><th className="p-2"></th><th className="p-2">القائمة التلقائية</th><th className="p-2">أسئلة البداية</th><th className="p-2">القائمة الثابتة</th></tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {rows.map((r) => <tr key={r[0]}><th className="p-2 font-bold">{r[0]}</th><td className="p-2">{r[1]}</td><td className="p-2">{r[2]}</td><td className="p-2">{r[3]}</td></tr>)}
            </tbody>
          </table>
        </div>
        <p className="muted text-xs">أسئلة البداية والقائمة الثابتة تنحفظ في حساب إنستقرام نفسه لما تحفظ القائمة، وتردّ بنفس ردود خياراتك فما تحتاج تكتبها مرتين. التغيير قد ياخذ وقت حتى يظهر في المحادثات القديمة.</p>
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
