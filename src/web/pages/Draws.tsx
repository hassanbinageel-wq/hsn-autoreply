import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Link, navigate } from "../App";
import { Alert, Card, Field, Modal, PageHeader, Spinner, Toggle, fmtTime, toast, useAsync } from "../components/ui";
import { toCsv } from "../../shared/csv";
import { canvasesToPdf, renderPages, saveBlob, type PdfLine } from "../lib/pdf";
import { Celebration } from "../components/Celebration";

// ---------------------------------------------------------------------------------------------------------------
// Settings form (create + edit while draft)
// ---------------------------------------------------------------------------------------------------------------

interface DrawForm {
  name: string;
  source_type: "media" | "story";
  media_id: string;
  url: string;
  winners_count: number;
  starts_at: number | null;
  ends_at: number | null;
  include_replies: boolean;
  keyword: string;
  exclude_own: boolean;
  excluded_text: string;
  entry_mode: "per_person" | "per_comment";
  allow_repeat_winner: boolean;
  exclude_previous_winners: boolean;
}

const EMPTY: DrawForm = {
  name: "",
  source_type: "media",
  media_id: "",
  url: "",
  winners_count: 1,
  starts_at: null,
  ends_at: null,
  include_replies: false,
  keyword: "",
  exclude_own: true,
  excluded_text: "",
  entry_mode: "per_person",
  allow_repeat_winner: false,
  exclude_previous_winners: false,
};

const deviceTz = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
})();

const toLocalInput = (ms: number | null) => {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (v: string) => (v ? new Date(v).getTime() : null);

function payload(f: DrawForm) {
  return {
    name: f.name.trim(),
    source_type: f.source_type,
    media_id: f.media_id || undefined,
    url: f.url.trim() || undefined,
    winners_count: f.winners_count,
    starts_at: f.starts_at,
    ends_at: f.ends_at,
    timezone: deviceTz,
    include_replies: f.source_type === "media" && f.include_replies,
    keyword: f.keyword.trim() || null,
    exclude_own: f.exclude_own,
    excluded_accounts: f.excluded_text.split(/[\n,،\s]+/).map((x) => x.trim()).filter(Boolean),
    entry_mode: f.entry_mode,
    allow_repeat_winner: f.entry_mode === "per_comment" && f.allow_repeat_winner,
    exclude_previous_winners: f.exclude_previous_winners,
  };
}

function SourcePicker({ form, set, locked }: { form: DrawForm; set: (p: Partial<DrawForm>) => void; locked: boolean }) {
  const [media, setMedia] = useState<any[] | null>(null);
  const [stories, setStories] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"list" | "url">("list");
  const load = () => {
    api("/api/media?kind=media").then((r) => setMedia(r.items)).catch(() => setMedia([]));
    api("/api/media?kind=story").then((r) => setStories(r.items)).catch(() => setStories([]));
  };
  useEffect(load, []);
  const refresh = async (kind: "media" | "story") => {
    setBusy(true);
    try {
      await api("/api/media/refresh", { body: { kind, all: true } });
      load();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  if (locked) return null;
  const list = form.source_type === "media" ? media : stories;
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <button type="button" className={`btn ${form.source_type === "media" ? "btn-primary" : "btn-ghost"}`} onClick={() => set({ source_type: "media", media_id: "", url: "" })}>
          منشور أو ريلز
        </button>
        <button type="button" className={`btn ${form.source_type === "story" ? "btn-primary" : "btn-ghost"}`} onClick={() => set({ source_type: "story", media_id: "", url: "", include_replies: false })}>
          ردود ستوري (عبر الخاص)
        </button>
      </div>
      {form.source_type === "story" ? (
        <Alert tone="info">
          <b>ردود الستوري</b> تصل كرسائل خاصة مرتبطة بالستوري (reply_to.story). يشمل السحب فقط الردود التي وصلت للنظام عبر التنبيهات منذ ربط الحساب ومرتبطة
          بهذه الستوري تحديدًا — لا توفر Meta طريقة لاسترجاع ردود أقدم، ولا تُدخل المنشنات أو الرسائل العادية.
        </Alert>
      ) : (
        <div className="flex gap-2 text-sm">
          <button type="button" className={`rounded-full px-3 py-1 ${mode === "list" ? "bg-brand-600 text-white" : "surface-2"}`} onClick={() => setMode("list")}>
            من قائمة المحتوى
          </button>
          <button type="button" className={`rounded-full px-3 py-1 ${mode === "url" ? "bg-brand-600 text-white" : "surface-2"}`} onClick={() => setMode("url")}>
            لصق رابط
          </button>
        </div>
      )}
      {form.source_type === "media" && mode === "url" ? (
        <Field label="رابط المنشور أو الريلز" hint="يجب أن يكون من حسابك المربوط. سيتحقق النظام من إمكانية الوصول إليه عبر Meta عند الحفظ.">
          <input className="input" dir="ltr" placeholder="https://www.instagram.com/reel/..." value={form.url} onChange={(e) => set({ url: e.target.value, media_id: "" })} />
        </Field>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-ghost text-sm" disabled={busy} onClick={() => refresh(form.source_type)}>
              {busy ? "جارٍ الجلب…" : form.source_type === "media" ? "🔄 تحديث المنشورات" : "🔄 جلب الستوري الحالية"}
            </button>
            {form.source_type === "story" && <span className="muted text-xs">تظهر الستوري الحالية والستوري التي حُفظت سابقًا.</span>}
          </div>
          {!list ? (
            <Spinner />
          ) : !list.length ? (
            <p className="muted text-sm">لا توجد عناصر — اضغط زر التحديث.</p>
          ) : (
            <div className="grid max-h-80 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6">
              {list.map((m) => (
                <button
                  key={m.media_id}
                  type="button"
                  onClick={() => set({ media_id: m.media_id, url: "" })}
                  className={`relative aspect-[4/5] overflow-hidden rounded-lg border-2 ${form.media_id === m.media_id ? "border-[var(--color-brand-500)]" : "border-transparent"}`}
                  title={m.caption ?? ""}
                >
                  {m.thumbnail_url ? (
                    <img src={m.thumbnail_url} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                  ) : (
                    <div className="surface-2 flex h-full items-center justify-center text-xl">🎞️</div>
                  )}
                  {m.media_product_type === "REELS" && <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] text-white">ريلز</span>}
                  {form.media_id === m.media_id && <span className="absolute left-1 top-1 rounded-full bg-[var(--color-brand-500)] px-1.5 text-xs text-white">✓</span>}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SettingsFields({ form, set }: { form: DrawForm; set: (p: Partial<DrawForm>) => void }) {
  const perPerson = form.entry_mode === "per_person";
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="اسم السحب">
          <input className="input" value={form.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} placeholder="سحب ريل المونتاج" />
        </Field>
        <Field label="عدد الفائزين">
          <input className="input" type="number" min={1} max={500} value={form.winners_count} onChange={(e) => set({ winners_count: Math.max(1, Number(e.target.value) || 1) })} />
        </Field>
        <Field label="بداية فترة المشاركات (اختياري)" hint={`بتوقيت جهازك: ${deviceTz}`}>
          <input className="input" type="datetime-local" value={toLocalInput(form.starts_at)} onChange={(e) => set({ starts_at: fromLocalInput(e.target.value) })} />
        </Field>
        <Field label="نهاية فترة المشاركات (اختياري)" hint={`بتوقيت جهازك: ${deviceTz}`}>
          <input className="input" type="datetime-local" value={toLocalInput(form.ends_at)} onChange={(e) => set({ ends_at: fromLocalInput(e.target.value) })} />
        </Field>
        <Field label="كلمة أو عبارة يجب وجودها (اختياري)" hint="المقارنة تتجاهل التشكيل والفرق بين أ/إ/ا و ة/ه و ى/ي.">
          <input className="input" value={form.keyword} maxLength={100} onChange={(e) => set({ keyword: e.target.value })} placeholder="مثال: مسابقة" />
        </Field>
        <Field label="حسابات مستبعدة يدويًا" hint="اسم مستخدم في كل سطر (مع @ أو بدونها). يمكنك أيضًا الاستبعاد من قائمة المشاركين.">
          <textarea className="input min-h-[80px]" dir="ltr" value={form.excluded_text} onChange={(e) => set({ excluded_text: e.target.value })} placeholder={"@account_one\naccount_two"} />
        </Field>
      </div>
      {form.source_type === "media" && (
        <Toggle checked={form.include_replies} onChange={(v) => set({ include_replies: v })} label="احتساب الردود على التعليقات" description="عند الإيقاف تُحتسب التعليقات الأساسية فقط." />
      )}
      <Toggle checked={form.exclude_own} onChange={(v) => set({ exclude_own: v })} label="استبعاد حسابي" />

      <Card className="surface-2" title="طريقة احتساب المشاركات">
        <div className="space-y-2">
          <label className="flex items-start gap-2">
            <input type="radio" className="mt-1.5" checked={perPerson} onChange={() => set({ entry_mode: "per_person", allow_repeat_winner: false })} />
            <span>
              <b>فرصة واحدة لكل شخص</b>
              <span className="muted block text-sm">مهما كان عدد تعليقاته — تتساوى فرص كل الحسابات المؤهلة.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" className="mt-1.5" checked={!perPerson} onChange={() => set({ entry_mode: "per_comment" })} />
            <span>
              <b>كل تعليق مؤهل فرصة مستقلة</b>
              <span className="muted block text-sm">تزيد فرص الشخص بعدد تعليقاته المؤهلة.</span>
            </span>
          </label>
        </div>
      </Card>

      <Card className="surface-2" title="السماح بتكرار الفائز داخل السحب">
        <Toggle
          checked={!perPerson && form.allow_repeat_winner}
          onChange={(v) => set({ allow_repeat_winner: v })}
          disabled={perPerson}
          label={form.allow_repeat_winner && !perPerson ? "مسموح — يمكن للحساب الفوز أكثر من مرة بتعليقات مختلفة" : "غير مسموح — الحساب يفوز مرة واحدة فقط"}
          description={
            perPerson
              ? "معطّل لأنك اخترت «فرصة واحدة لكل شخص»: كل شخص له فرصة واحدة، فلا يمكن أن يفوز مرتين."
              : form.allow_repeat_winner
                ? "لا يُختار التعليق نفسه مرتين أبدًا."
                : "بعد فوز الحساب تُستبعد جميع تعليقاته من بقية الاختيارات."
          }
        />
      </Card>
      <Toggle
        checked={form.exclude_previous_winners}
        onChange={(v) => set({ exclude_previous_winners: v })}
        label="استبعاد من فاز في سحوبات سابقة بهذه الحملة"
        description="يُطابَق بمعرّف الحساب الثابت الذي يرسله إنستقرام، وليس بالاسم الظاهر."
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Campaign draws list + create
// ---------------------------------------------------------------------------------------------------------------

export function DrawsHomePage() {
  const { data: draws } = useAsync(() => api<any[]>("/api/draws"), []);
  const { data: campaigns } = useAsync(() => api<any[]>("/api/campaigns"), []);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<DrawForm>(EMPTY);
  const [campaignId, setCampaignId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<DrawForm>) => setForm((f) => ({ ...f, ...p }));
  useEffect(() => {
    if (campaignId === "" && campaigns?.length) setCampaignId(campaigns[0].id);
  }, [campaigns, campaignId]);

  const create = async () => {
    if (!campaignId) return toast("اختر الحملة المرتبطة بالسحب", "bad");
    setBusy(true);
    try {
      const r = await api(`/api/campaigns/${campaignId}/draws`, { body: payload(form) });
      toast("تم إنشاء السحب");
      navigate(`/draws/${r.id}`);
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };

  const STATUS: Record<string, string> = { draft: "مسودة", drawing: "قيد السحب", drawn: "اكتمل" };
  return (
    <div className="space-y-4">
      <PageHeader
        title="🎁 السحوبات"
        subtitle="سحب عشوائي عادل للفائزين من تعليقات منشوراتك وريلزاتك أو ردود الستوري. الاختيار يتم على الخادم بمولد أرقام عشوائية آمن."
        actions={<button className="btn btn-primary" onClick={() => setCreating(true)}>+ سحب جديد</button>}
      />
      {creating && (
        <Modal open onClose={() => setCreating(false)} title="سحب جديد">
          <div className="space-y-4">
            <Field label="الحملة المرتبطة" hint="تُستخدم لتنظيم السحوبات ولخيار «استبعاد من فاز في سحوبات سابقة بهذه الحملة».">
              <select className="input" value={campaignId} onChange={(e) => setCampaignId(e.target.value ? Number(e.target.value) : "")}>
                {!campaigns?.length && <option value="">— لا توجد حملات، أنشئ حملة أولًا —</option>}
                {campaigns?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <SourcePicker form={form} set={set} locked={false} />
            <SettingsFields form={form} set={set} />
            <button className="btn btn-primary w-full" disabled={busy || !campaignId || !form.name.trim() || (!form.media_id && !form.url.trim())} onClick={create}>
              {busy ? "جارٍ التحقق…" : "إنشاء السحب"}
            </button>
          </div>
        </Modal>
      )}
      <Card title="سجل السحوبات">
        {!draws ? (
          <Spinner />
        ) : !draws.length ? (
          <p className="muted py-6 text-center text-sm">لا توجد سحوبات بعد — اضغط «+ سحب جديد».</p>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {draws.map((d) => (
              <Link key={d.id} to={`/draws/${d.id}`} className="flex items-center gap-3 py-2.5 hover:bg-[var(--surface-2)]">
                <div className="h-14 w-11 shrink-0 overflow-hidden rounded-md bg-gradient-to-br from-violet-700 to-orange-500">
                  {d.media_thumb && <img src={d.media_thumb} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold">{d.name}</div>
                  <div className="muted text-xs">
                    {d.campaign_name ? `${d.campaign_name} · ` : ""}
                    {d.source_type === "story" ? "ردود ستوري" : "تعليقات منشور"} · {d.active_winners}/{d.winners_count} فائز · {d.fetched_count} مشاركة ·{" "}
                    {d.drawn_at ? `اكتمل ${fmtTime(d.drawn_at)}` : `أُنشئ ${fmtTime(d.created_at)}`}
                  </div>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs ${d.status === "drawn" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "surface-2"}`}>{STATUS[d.status]}</span>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Draw page: fetch, preview, run (animation), results, replace, export
// ---------------------------------------------------------------------------------------------------------------

/** Keeps a left-to-right token (e.g. @username, a link) intact inside Arabic text (Unicode isolate). */
const ltr = (t: string) => `\u2066${t}\u2069`;

function ordinal(n: number): string {
  const o = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس", "السابع", "الثامن", "التاسع", "العاشر"];
  return o[n - 1] ?? `رقم ${n}`;
}

const newRequestId = () => {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return "req_" + Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
};

function Countdown({ title, names, winner, onDone }: { title: string; names: string[]; winner: any; onDone: () => void }) {
  const [n, setN] = useState(3);
  const [spin, setSpin] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (n > 0) {
      const t = setTimeout(() => setN(n - 1), 850);
      return () => clearTimeout(t);
    }
    // Purely visual shuffle over participant names; the winner was already chosen and saved on the server.
    let i = 0;
    const iv = setInterval(() => {
      setSpin(names.length ? names[Math.floor(Math.random() * names.length)] : "…");
      if (++i > 24) {
        clearInterval(iv);
        setRevealed(true);
      }
    }, 85);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-gradient-to-br from-violet-900 via-fuchsia-800 to-orange-700 p-6 text-center text-white" onClick={() => revealed && onDone()}>
      <div className="mb-6 text-2xl font-bold opacity-90">🎁 {title}</div>
      {n > 0 ? (
        <div key={n} className="count-pop text-[9rem] font-black leading-none drop-shadow-lg">{n}</div>
      ) : !revealed ? (
        <div>
          <div className="mb-3 text-lg opacity-80">جارٍ الاختيار…</div>
          <div className="text-4xl font-black" dir="ltr">@{spin}</div>
        </div>
      ) : (
        <div className="count-pop">
          <div className="mb-2 text-xl opacity-90">🎉 مبروك</div>
          <div className="text-5xl font-black drop-shadow-lg" dir="ltr">{winner?.author_username ? `@${winner.author_username}` : "فائز"}</div>
          {winner?.text && <div className="mx-auto mt-4 max-w-xl text-lg opacity-90">«{winner.text}»</div>}
          <div className="mt-8 text-sm opacity-70">اضغط في أي مكان للمتابعة</div>
        </div>
      )}
      {revealed && <Celebration />}
    </div>
  );
}

function WinnerCard({ w, onReplace }: { w: any; onReplace?: () => void }) {
  return (
    <div className="card count-pop flex items-start gap-3 p-4">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-600 text-xl font-black text-white">{w.position}</div>
      <div className="min-w-0 flex-1">
        {w.author_username ? (
          <a href={`https://www.instagram.com/${w.author_username}`} target="_blank" rel="noreferrer" className="text-lg font-bold hover:underline" dir="ltr">
            @{w.author_username}
          </a>
        ) : (
          <span className="muted text-lg font-bold">حساب غير معروف الاسم (المعرّف محفوظ)</span>
        )}
        <div className="mt-1 whitespace-pre-wrap break-words text-sm">«{w.text ?? ""}»</div>
        <div className="muted mt-1 text-xs">
          {w.source === "reply" ? "رد على تعليق" : w.source === "story_reply" ? "رد على الستوري" : "تعليق"}
          {w.created_time ? ` · ${fmtTime(w.created_time)}` : ""}
        </div>
      </div>
      {onReplace && (
        <button className="btn btn-ghost shrink-0 text-xs" onClick={onReplace}>
          🔁 استبدال
        </button>
      )}
    </div>
  );
}

export function DrawPage({ id }: { id: number }) {
  const { data, loading, error, reload } = useAsync(() => api<any>(`/api/draws/${id}`), [id]);
  const [form, setForm] = useState<DrawForm | null>(null);
  const [fetching, setFetching] = useState(false);
  const [running, setRunning] = useState(false);
  const [anim, setAnim] = useState<{ title: string; winner: any } | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "eligible" | "excluded">("all");
  const [replaceFor, setReplaceFor] = useState<any>(null);
  const [reason, setReason] = useState("");
  const reqId = useRef<string>(newRequestId());
  const stopFetch = useRef(false);

  const d = data?.draw;
  useEffect(() => {
    if (!d) return;
    setForm({
      ...EMPTY,
      name: d.name,
      source_type: d.source_type,
      media_id: d.media_id,
      winners_count: d.winners_count,
      starts_at: d.starts_at,
      ends_at: d.ends_at,
      include_replies: !!d.include_replies,
      keyword: d.keyword ?? "",
      exclude_own: !!d.exclude_own,
      excluded_text: (d.excluded_accounts ?? []).join("\n"),
      entry_mode: d.entry_mode,
      allow_repeat_winner: !!d.allow_repeat_winner,
      exclude_previous_winners: !!d.exclude_previous_winners,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.id, d?.updated_at]);

  const entries: any[] = data?.preview?.entries ?? [];
  const list = useMemo(() => {
    const k = q.trim().toLowerCase().replace(/^@/, "");
    return entries.filter(
      (e) =>
        (filter === "all" || (filter === "eligible" ? e.eligible : !e.eligible)) &&
        (!k || (e.author_username ?? "").toLowerCase().includes(k) || (e.text ?? "").toLowerCase().includes(k)),
    );
  }, [entries, q, filter]);

  if (loading && !data) return <Spinner />;
  if (error) return <Alert tone="bad">{error}</Alert>;
  if (!d || !form) return <Spinner />;
  const pv = data.preview;
  const labels: Record<string, string> = data.labels ?? {};
  const locked = d.status !== "draft"; // settings and entries are frozen from the first pick
  const winners: any[] = data.winners ?? [];
  const active = winners.filter((w) => w.status === "active").sort((a, b) => a.position - b.position);
  const history = winners.filter((w) => w.status === "replaced");
  const set = (p: Partial<DrawForm>) => setForm((f) => ({ ...(f as DrawForm), ...p }));

  const saveSettings = async () => {
    try {
      await api(`/api/draws/${id}`, { method: "PUT", body: payload(form) });
      toast("تم حفظ الإعدادات");
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };

  // Fetches batch after batch until complete (or an error / rate limit stops it).
  const fetchAll = async (restart = false) => {
    setFetching(true);
    stopFetch.current = false;
    try {
      let first = true;
      for (let i = 0; i < 200 && !stopFetch.current; i++) {
        const r = await api(`/api/draws/${id}/fetch`, { body: { restart: restart && first } });
        first = false;
        await reload();
        if (r.fetch_status !== "partial" || r.fetch_error) break;
      }
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setFetching(false);
      reload();
    }
  };

  const excludeAccount = async (e: any) => {
    const token = e.author_id ? `id:${e.author_id}` : `@${e.author_username}`;
    const next = { ...form, excluded_text: [...form.excluded_text.split("\n").filter(Boolean), token].join("\n") };
    setForm(next);
    try {
      await api(`/api/draws/${id}`, { method: "PUT", body: payload(next) });
      toast(`استُبعد ${e.author_username ? "@" + e.author_username : "الحساب"}`);
      reload();
    } catch (err: any) {
      toast(err.message, "bad");
    }
  };

  // Picks the next winner on the server (the same request id is reused until it succeeds, so a retry never picks twice).
  const pickNextWinner = async (position: number) => {
    setRunning(true);
    try {
      const r = await api(`/api/draws/${id}/next`, { body: { request_id: reqId.current } });
      reqId.current = newRequestId();
      const winner = (r.winners as any[]).find((w) => w.id === r.winner_id);
      setAnim({ title: `الفائز ${ordinal(position)}`, winner });
    } catch (e: any) {
      toast(e.message, "bad");
      if (e.status !== 0) reqId.current = newRequestId();
    } finally {
      setRunning(false);
    }
  };
  const animDone = () => {
    setAnim(null);
    reload();
  };

  const doReplace = async () => {
    try {
      await api(`/api/draws/${id}/winners/${replaceFor.id}/replace`, { body: { reason } });
      toast("تم اختيار فائز بديل");
      setReplaceFor(null);
      setReason("");
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };

  const exportCsv = () => {
    const headers = ["الترتيب", "الحساب", "المعرّف", "المشاركة", "النوع", "وقت المشاركة", "الحالة", "سبب الاستبدال"];
    const rows = [...active, ...history].map((w) => ({
      الترتيب: w.position,
      الحساب: w.author_username ?? "",
      المعرّف: w.author_id ?? "",
      المشاركة: w.text ?? "",
      النوع: w.source === "reply" ? "رد" : w.source === "story_reply" ? "رد ستوري" : "تعليق",
      "وقت المشاركة": w.created_time ? fmtTime(w.created_time) : "",
      الحالة: w.status === "active" ? "فائز" : "مستبدَل",
      "سبب الاستبدال": w.replaced_reason ?? "",
    }));
    saveBlob(new Blob([toCsv(headers, rows)], { type: "text/csv;charset=utf-8" }), `draw-${id}-results.csv`);
  };
  const exportPdf = () => {
    const lines: PdfLine[] = [
      { text: `نتائج السحب: ${d.name}`, size: 44, bold: true, gap: 10 },
      { text: `الحملة: ${data.campaign?.name ?? ""}`, size: 26, color: "#374151" },
      { text: `المصدر: ${d.source_type === "story" ? "ردود ستوري" : "تعليقات منشور"}${d.media_permalink ? ` — ${ltr(d.media_permalink)}` : ""}`, size: 22, color: "#374151" },
      { text: `وقت التنفيذ: ${d.drawn_at ? fmtTime(d.drawn_at) : "—"}`, size: 22, color: "#374151" },
      {
        text: `المشاركات: ${pv.total} · المؤهلة: ${pv.eligible_count} · حسابات فريدة: ${pv.unique_people} · الطريقة: ${d.entry_mode === "per_person" ? "فرصة واحدة لكل شخص" : "كل تعليق فرصة"}${d.keyword ? ` · الكلمة: ${d.keyword}` : ""}`,
        size: 22,
        color: "#374151",
        gap: 24,
      },
      { text: "الفائزون", size: 34, bold: true, gap: 10 },
      ...active.map((w) => ({
        text: `المركز ${w.position}: ${w.author_username ? ltr("@" + w.author_username) : "حساب غير معروف الاسم"}\n«${w.text ?? ""}»`,
        size: 28,
        box: true,
        gap: 14,
      })),
      ...(history.length
        ? [
            { text: "سجل الاستبدال", size: 28, bold: true, gap: 8 } as PdfLine,
            ...history.map((w) => ({ text: `المركز ${w.position}: ${w.author_username ? ltr("@" + w.author_username) : "—"} — استُبدل: ${w.replaced_reason ?? ""}`, size: 22, color: "#6b7280" })),
          ]
        : []),
      { text: "تم الاختيار عشوائيًا على الخادم بمولد أرقام عشوائية آمن (crypto.getRandomValues) بتوزيع غير منحاز.", size: 18, color: "#6b7280", gap: 0 },
    ];
    saveBlob(canvasesToPdf(renderPages(lines, `HSN AutoReply — ${d.name}`)), `draw-${id}-results.pdf`);
  };

  const firstPickOk = d.fetch_status === "complete" && (d.status !== "draft" || (pv.max_winners != null && d.winners_count <= pv.max_winners && pv.eligible_count > 0));
  const byPosition = new Map(active.map((w) => [w.position, w]));
  const nextPosition = Array.from({ length: d.winners_count }, (_, i) => i + 1).find((p) => !byPosition.has(p)) ?? null;

  return (
    <div className="space-y-4">
      {anim && <Countdown title={anim.title} winner={anim.winner} names={entries.filter((e) => e.eligible && e.author_username).map((e) => e.author_username)} onDone={animDone} />}
      <PageHeader
        title={`🎁 ${d.name}`}
        subtitle={`حملة «${data.campaign?.name ?? ""}» · ${d.source_type === "story" ? "ردود ستوري" : "تعليقات منشور"}`}
        actions={<Link to="/draws" className="btn btn-ghost">→ كل السحوبات</Link>}
      />

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card>
          <a href={d.media_permalink ?? undefined} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg">
            {d.media_thumb ? (
              <img src={d.media_thumb} alt="" referrerPolicy="no-referrer" className="aspect-[4/5] w-full object-cover" />
            ) : (
              <div className="surface-2 flex aspect-[4/5] items-center justify-center text-4xl">{d.source_type === "story" ? "📱" : "🎞️"}</div>
            )}
          </a>
          {d.media_caption && <p className="muted mt-2 line-clamp-3 text-xs">{d.media_caption}</p>}
          {d.media_comments_count != null && <p className="mt-2 text-xs">إنستقرام يذكر {d.media_comments_count} تعليقًا على المنشور.</p>}
        </Card>

        <div className="space-y-4">
          <Card title="1) جلب المشاركات">
            <div className="space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span>
                  الحالة:{" "}
                  <b>
                    {{ idle: "لم يبدأ", partial: "ناقص — لم يكتمل", complete: "مكتمل ✅", error: "خطأ" }[d.fetch_status as string]}
                  </b>
                </span>
                <span className="muted">· تم جلب {d.fetched_count} مشاركة</span>
                {d.fetch_updated_at && <span className="muted">· آخر تحديث {fmtTime(d.fetch_updated_at)}</span>}
              </div>
              {d.fetch_error && <Alert tone="warn">{d.fetch_error}</Alert>}
              {d.source_type === "media" && d.fetch_status === "complete" && d.media_comments_count != null && d.fetched_count < d.media_comments_count && (
                <Alert tone="info">
                  جُلب {d.fetched_count} من أصل {d.media_comments_count} يذكرها إنستقرام. الفرق عادةً تعليقات محذوفة أو مخفية أو مقيّدة لا تعيدها واجهة Meta — هذا كل ما
                  تتيحه الواجهة الرسمية.
                </Alert>
              )}
              {!locked && (
                <div className="flex flex-wrap gap-2">
                  <button className="btn btn-primary" disabled={fetching} onClick={() => fetchAll(false)}>
                    {fetching ? "جارٍ الجلب…" : d.fetch_status === "idle" ? "جلب المشاركات" : d.fetch_status === "complete" ? "🔄 جلب الجديد" : "متابعة الجلب"}
                  </button>
                  {fetching && <button className="btn btn-ghost" onClick={() => (stopFetch.current = true)}>إيقاف</button>}
                  {d.fetch_status !== "idle" && !fetching && (
                    <button className="btn btn-ghost" onClick={() => confirm("حذف المشاركات المجلوبة والجلب من البداية؟") && fetchAll(true)}>إعادة الجلب من البداية</button>
                  )}
                </div>
              )}
              {locked && <p className="muted text-xs">بدأ السحب — المشاركات والإعدادات مجمّدة كنسخة ثابتة.</p>}
            </div>
          </Card>

          <Card title="2) الإعدادات">
            {locked ? (
              <ul className="space-y-1 text-sm">
                <li>عدد الفائزين: <b>{d.winners_count}</b></li>
                <li>الطريقة: <b>{d.entry_mode === "per_person" ? "فرصة واحدة لكل شخص" : "كل تعليق فرصة"}</b> · تكرار الفائز: <b>{d.allow_repeat_winner ? "مسموح" : "غير مسموح"}</b></li>
                <li>الفترة: {d.starts_at ? fmtTime(d.starts_at) : "—"} ← {d.ends_at ? fmtTime(d.ends_at) : "—"} {d.timezone ? `(${d.timezone})` : ""}</li>
                {d.keyword && <li>الكلمة المطلوبة: «{d.keyword}»</li>}
                <li>الردود: {d.include_replies ? "مُحتسبة" : "مستبعدة"} · حسابي: {d.exclude_own ? "مستبعد" : "مسموح"} · الفائزون السابقون: {d.exclude_previous_winners ? "مستبعدون" : "مسموح"}</li>
              </ul>
            ) : (
              <div className="space-y-3">
                <SettingsFields form={form} set={set} />
                <button className="btn btn-primary" onClick={saveSettings}>حفظ الإعدادات</button>
              </div>
            )}
          </Card>
        </div>
      </div>

      <Card title="3) المعاينة قبل السحب">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="surface-2 rounded-xl p-3 text-center"><div className="text-2xl font-bold">{pv.total}</div><div className="muted text-xs">مشاركات مجلوبة</div></div>
          <div className="surface-2 rounded-xl p-3 text-center"><div className="text-2xl font-bold text-emerald-600">{pv.eligible_count}</div><div className="muted text-xs">مؤهلة</div></div>
          <div className="surface-2 rounded-xl p-3 text-center"><div className="text-2xl font-bold">{pv.total - pv.eligible_count}</div><div className="muted text-xs">مستبعدة</div></div>
          <div className="surface-2 rounded-xl p-3 text-center"><div className="text-2xl font-bold">{pv.unique_people}</div><div className="muted text-xs">حسابات فريدة مؤهلة</div></div>
        </div>
        {Object.keys(pv.reasons ?? {}).length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
            {Object.entries(pv.reasons).map(([k, v]) => (
              <span key={k} className="surface-2 rounded-full px-2 py-1">{labels[k] ?? k}: <b>{String(v)}</b></span>
            ))}
          </div>
        )}
        {!pv.identity_reliable && (
          <Alert tone="warn">بعض المشاركات بدون معرّف حساب ثابت من Meta؛ تُميَّز هذه الحسابات باسم المستخدم فقط، فلا يمكن ضمان منع التكرار لها بالكامل.</Alert>
        )}
        {pv.max_winners != null && d.winners_count > pv.max_winners && (
          <Alert tone="bad">عدد الفائزين المطلوب ({d.winners_count}) أكبر من الممكن وفق إعداداتك ({pv.max_winners}). عدّل العدد أو الإعدادات — لن يُغيَّر تلقائيًا.</Alert>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input className="input max-w-xs" placeholder="بحث بالحساب أو النص…" value={q} onChange={(e) => setQ(e.target.value)} />
          {(["all", "eligible", "excluded"] as const).map((k) => (
            <button key={k} className={`rounded-full px-3 py-1 text-xs ${filter === k ? "bg-brand-600 text-white" : "surface-2"}`} onClick={() => setFilter(k)}>
              {{ all: "الكل", eligible: "المؤهلة", excluded: "المستبعدة" }[k]}
            </button>
          ))}
          <span className="muted text-xs">{list.length} نتيجة</span>
        </div>
        <div className="mt-2 max-h-96 divide-y divide-[var(--border)] overflow-y-auto">
          {list.slice(0, 600).map((e) => (
            <div key={e.id} className="flex items-start gap-2 py-2 text-sm">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${e.eligible ? "bg-emerald-500" : "bg-slate-400"}`} />
              <div className="min-w-0 flex-1">
                <span className="font-semibold" dir="ltr">{e.author_username ? `@${e.author_username}` : "بدون اسم"}</span>
                {e.source === "reply" && <span className="muted text-xs"> · رد</span>}
                <span className="muted text-xs"> · {e.created_time ? fmtTime(e.created_time) : "—"}</span>
                <div className="break-words">{e.text}</div>
                {!e.eligible && e.reason && <div className="text-xs text-amber-600">مستبعد: {labels[e.reason] ?? e.reason}</div>}
              </div>
              {!locked && e.eligible && (e.author_id || e.author_username) && (
                <button className="btn btn-ghost shrink-0 text-xs" onClick={() => excludeAccount(e)}>استبعاد</button>
              )}
            </div>
          ))}
          {list.length > 600 && <p className="muted py-2 text-center text-xs">يُعرض أول 600 — استخدم البحث.</p>}
        </div>
      </Card>

      <Card title="4) السحب والنتائج">
        <div className="space-y-3">
          {d.fetch_status !== "complete" && d.status === "draft" && <Alert tone="warn">أكمل جلب المشاركات أولًا — لا يبدأ السحب على بيانات ناقصة.</Alert>}
          {d.status !== "draft" && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">
                {d.status === "drawn" ? `اكتمل السحب ${d.drawn_at ? fmtTime(d.drawn_at) : ""}` : `تم اختيار ${active.length} من ${d.winners_count}`} · من {d.eligible_count} مشاركة مؤهلة ({d.unique_people} حساب)
              </span>
              {active.length > 0 && (
                <>
                  <button className="btn btn-ghost text-sm" onClick={exportCsv}>⬇️ CSV</button>
                  <button className="btn btn-ghost text-sm" onClick={exportPdf}>⬇️ PDF</button>
                </>
              )}
            </div>
          )}
          <div className="space-y-2">
            {Array.from({ length: d.winners_count }, (_, i) => i + 1).map((pos) => {
              const w = byPosition.get(pos);
              if (w) return <WinnerCard key={w.id} w={w} onReplace={() => setReplaceFor(w)} />;
              if (pos === nextPosition)
                return (
                  <button key={pos} className="btn btn-primary w-full py-4 text-lg" disabled={running || !firstPickOk} onClick={() => pickNextWinner(pos)}>
                    {running ? "جارٍ الاختيار…" : `🎲 اختر الفائز ${ordinal(pos)}`}
                  </button>
                );
              return (
                <div key={pos} className="surface-2 rounded-xl p-4 text-center text-sm opacity-60">
                  المركز {pos} — الفائز {ordinal(pos)} (بعد اختيار السابق)
                </div>
              );
            })}
          </div>
          <p className="muted text-xs">
            كل فائز يُختار على الخادم عند ضغطك ويُحفظ فورًا؛ الحركة للعرض فقط ولا تؤثر على النتيجة. الضغط المتكرر لا يختار فائزًا إضافيًا. بعد اختيار الفائز الأول تُجمَّد
            الإعدادات والمشاركات. لا تُرسل أي رسائل ولا تُنشر الأسماء تلقائيًا.
          </p>
          {history.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer font-semibold">سجل الاستبدال ({history.length})</summary>
              <ul className="mt-2 space-y-1">
                {history.map((w) => (
                  <li key={w.id} className="muted">
                    المركز {w.position}: {w.author_username ? `@${w.author_username}` : "—"} — استُبدل {w.replaced_at ? fmtTime(w.replaced_at) : ""} بسبب: {w.replaced_reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </Card>

      {replaceFor && (
        <Modal open onClose={() => setReplaceFor(null)} title={`استبدال الفائز في المركز ${replaceFor.position}`}>
          <p className="mb-2 text-sm">
            سيُستبعد {replaceFor.author_username ? `@${replaceFor.author_username}` : "هذا الحساب"} من هذا السحب، ويُختار بديل عشوائيًا بنفس القواعد. تبقى النتيجة السابقة في السجل.
          </p>
          <Field label="سبب الاستبدال">
            <input className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="مثال: لم يرد خلال 48 ساعة" />
          </Field>
          <button className="btn btn-primary mt-3 w-full" disabled={reason.trim().length < 2} onClick={doReplace}>اختيار بديل</button>
        </Modal>
      )}
    </div>
  );
}
