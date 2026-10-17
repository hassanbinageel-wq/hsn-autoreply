import { useEffect, useMemo, useState } from "react";
import { DateTimeField } from "../components/DateTimeField";
import { api, ApiError } from "../api";
import { navigate } from "../App";
import { renderTemplate, claimsDelivery, claimsFollowRequired, contentLinkButton, publicReplyVariants, pickVariant, SAFE_PUBLIC_REPLIES, MAX_PUBLIC_VARIANTS, TEMPLATE_VARIABLES } from "../../shared/template";
import { evaluateMatch } from "../../shared/match";
import { AR_LABELS } from "../../shared/states";
import { Alert, Card, Field, InfoDot, Spinner, Toggle, currentTz, toast, fmtTime } from "../components/ui";
import { PhonePreview, type ChatMsg, type CommentMsg } from "../components/PhonePreview";
import { Icon } from "../components/Icon";

type Keyword = { keyword: string; kind: "include" | "exclude"; match_type: "exact" | "word" | "contains" };
type Form = {
  name: string;
  type: "comment" | "story_reply" | "story_mention";
  priority: number;
  scope: "all" | "selected";
  media_ids: string[];
  match_all: boolean;
  unify_alef: boolean;
  include_replies: boolean;
  keywords: Keyword[];
  require_follow: boolean;
  follow_invite: boolean;
  follow_invite_text: string;
  opening_text: string;
  follow_request_text: string;
  follow_reminder_text: string;
  verify_error_text: string;
  final_text: string;
  final_url: string;
  public_reply_enabled: boolean;
  public_reply_text: string;
  public_reply_on_dm_fail: "none" | "fallback";
  public_reply_fallback_text: string;
  schedule_start: number | null;
  schedule_end: number | null;
  timezone: string;
  per_user_cooldown_hours: number;
  max_deliveries_per_user: number;
  max_verify_attempts: number;
  verify_cooldown_seconds: number;
  process_old_events: boolean;
  track_clicks: boolean;
  store_coupon: string;
  stock_action: "notify" | "pause" | "waitlist";
  out_of_stock_text: string;
  follow_reminder_minutes: number;
  auto_new_media: boolean;
  auto_new_reels_only: boolean;
  auto_new_since: number | null;
};

const EMPTY: Form = {
  name: "",
  type: "comment",
  priority: 100,
  scope: "all",
  media_ids: [],
  match_all: false,
  unify_alef: true,
  include_replies: false,
  keywords: [],
  require_follow: false,
  follow_invite: false,
  follow_invite_text: "ونسعد بمتابعتك لحسابنا 💜",
  opening_text: "حياك الله 🙌 رد بكلمة ابدأ عشان أتحقق من المتابعة وأرسل لك المحتوى.",
  follow_request_text: "باقي خطوة بسيطة 🔥 تابع حسابنا {{account_link}} ثم ارجع هنا واضغط «تحقّق من المتابعة» عشان أوصلك المحتوى.",
  follow_reminder_text: "لسا ما ظهرت لنا متابعتك 🙏 تأكد إنك تابعت {{account_link}} ثم جرّب «تحقق» بعد دقيقة.",
  verify_error_text: "ما قدرنا نتحقق من المتابعة الآن ⏳ جرّب تكتب «تحقق» بعد شوي.",
  final_text: "تفضل 🎁 {{content_url}}",
  final_url: "",
  store_coupon: "",
  stock_action: "notify",
  out_of_stock_text: "",
  public_reply_enabled: false,
  public_reply_text: SAFE_PUBLIC_REPLIES.join("\n"),
  public_reply_on_dm_fail: "none",
  public_reply_fallback_text: "",
  schedule_start: null,
  schedule_end: null,
  timezone: "Asia/Aden",
  per_user_cooldown_hours: 24,
  max_deliveries_per_user: 1,
  max_verify_attempts: 5,
  verify_cooldown_seconds: 10,
  process_old_events: false,
  track_clicks: true,
  follow_reminder_minutes: 60,
  auto_new_media: false,
  auto_new_reels_only: false,
  auto_new_since: null,
};

const REMINDER_OPTIONS: Array<[number, string]> = [
  [0, "بدون تذكير"],
  [30, "بعد 30 دقيقة"],
  [60, "بعد ساعة"],
  [120, "بعد ساعتين"],
  [360, "بعد 6 ساعات"],
  [720, "بعد 12 ساعة"],
  [1380, "بعد 23 ساعة"],
];

const STEPS = [
  "اسم الحملة",
  "نوع الحدث",
  "نطاق التشغيل",
  "الكلمات والشروط",
  "استثناءات المطابقة",
  "المتابعة",
  "الرسالة التمهيدية",
  "طلب المتابعة وإعادة التحقق",
  "المحتوى النهائي",
  "الرد العام",
  "الجدول والأولوية والتكرار",
  "المعاينة والمحاكاة",
  "التفعيل",
];

// ---- time-zone aware conversion for <input type="datetime-local"> ----
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - utcMs;
}
function localInputToUtc(v: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return guess - tzOffsetMs(guess, tz);
}
function utcToLocalInput(ms: number | null, tz: string): string {
  if (!ms) return "";
  const d = new Date(ms + tzOffsetMs(ms, tz));
  return d.toISOString().slice(0, 16);
}

type MediaFilter = "all" | "reels" | "posts";

function MediaPicker({ media, selected, onChange, onRefreshed, kind = "media" }: { media: any[]; selected: string[]; onChange: (ids: string[]) => void; onRefreshed: (items: any[]) => void; kind?: "media" | "story" }) {
  const [filter, setFilter] = useState<MediaFilter>("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const isStory = kind === "story";
  const refresh = async () => {
    setBusy(true);
    try {
      const r = await api<{ count: number }>("/api/media/refresh", { body: { kind, all: true } });
      const m = await api(`/api/media?kind=${kind}`);
      onRefreshed(m.items);
      toast(isStory ? (r.count ? `تم جلب ${r.count} ستوري` : "لا توجد ستوري منشورة حاليًا (آخر 24 ساعة)") : `تم جلب ${r.count} منشور`);
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const isReel = (m: any) => m.media_product_type === "REELS";
  const list = media.filter(
    (m) => (isStory || filter === "all" || (filter === "reels" ? isReel(m) : !isReel(m))) && (!q.trim() || (m.caption ?? "").toLowerCase().includes(q.trim().toLowerCase())),
  );
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary" onClick={refresh} disabled={busy}>
          {busy ? "جارٍ الجلب…" : isStory ? (media.length ? "🔄 تحديث الستوري" : "جلب الستوري الحالية") : media.length ? "🔄 تحديث منشوراتي" : "جلب منشوراتي من إنستقرام"}
        </button>
        {!isStory && <div className="surface-2 flex rounded-xl p-1 text-sm" role="tablist">
          {([["all", "الكل"], ["reels", "ريلز"], ["posts", "منشورات"]] as const).map(([k, v]) => (
            <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)} className={`rounded-lg px-3 py-1.5 font-semibold ${filter === k ? "bg-[var(--surface)] shadow" : "muted"}`}>{v}</button>
          ))}
        </div>}
        <span className="muted text-sm">{list.length} عنصر · المحدد: {selected.length}</span>
      </div>
      {!isStory && media.length > 0 && <input className="input" placeholder="بحث في وصف المنشور…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث في المنشورات" />}
      {isStory && <p className="muted text-xs">تظهر هنا الستوري المنشورة حاليًا فقط (آخر 24 ساعة) — هذا ما يتيحه إنستقرام. الستوري المنتهية لا تستقبل ردودًا أصلًا.</p>}
      {!media.length && !busy && <Alert tone="info">{isStory ? "اضغط «جلب الستوري الحالية» لعرض الستوري المنشورة الآن." : "لم تُجلب منشوراتك بعد — اضغط «جلب منشوراتي»."}</Alert>}
      <div className="grid max-h-[28rem] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
        {list.map((m) => {
          const on = selected.includes(m.media_id);
          return (
            <button type="button" key={m.media_id} onClick={() => toggle(m.media_id)} title={m.caption ?? ""} className={`relative overflow-hidden rounded-lg border-2 ${on ? "border-brand-600 ring-2 ring-brand-500" : "border-transparent"}`}>
              {m.thumbnail_url ? <img src={m.thumbnail_url} alt={m.caption ?? ""} loading="lazy" className="aspect-[4/5] w-full object-cover" referrerPolicy="no-referrer" /> : <div className="surface-2 flex aspect-[4/5] items-center justify-center text-2xl">🎞️</div>}
              {isReel(m) && <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] text-white">▶ ريلز</span>}
              {on && <span className="absolute left-1 top-1 rounded-full bg-brand-700 px-1.5 text-xs text-white">✓</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function KeywordEditor({ kind, keywords, onChange }: { kind: "include" | "exclude"; keywords: Keyword[]; onChange: (k: Keyword[]) => void }) {
  const [kw, setKw] = useState("");
  const [mt, setMt] = useState<Keyword["match_type"]>("contains");
  const list = keywords.map((k, i) => ({ ...k, i })).filter((k) => k.kind === kind);
  const add = () => {
    const parts = kw.split(/[,،\n]/).map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return;
    onChange([...keywords, ...parts.map((p) => ({ keyword: p, kind, match_type: mt }))]);
    setKw("");
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input className="input" value={kw} onChange={(e) => setKw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} onBlur={add} placeholder={kind === "include" ? "مثال: كورس، دورة، course" : "مثال: سعر، كم"} aria-label={kind === "include" ? "كلمة تشغيل" : "كلمة استثناء"} />
        <select className="input sm:w-48" value={mt} onChange={(e) => setMt(e.target.value as Keyword["match_type"])} aria-label="نوع المطابقة">
          <option value="contains">يحتوي على (عبارة جزئية)</option>
          <option value="word">كلمة/عبارة كاملة</option>
          <option value="exact">مطابقة كاملة للنص</option>
        </select>
        <button type="button" className="btn btn-ghost" onClick={add}>إضافة</button>
      </div>
      <div className="flex flex-wrap gap-2">
        {list.map((k) => (
          <span key={k.i} className={`inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-sm font-bold ${kind === "include" ? "border-violet-300 bg-violet-500/10 text-violet-700 dark:border-violet-700 dark:text-violet-200" : "border-red-300 bg-red-500/10 text-red-700 dark:border-red-800 dark:text-red-300"}`}>
            {k.keyword} <span className="text-xs font-medium opacity-70">{{ contains: "يحتوي", word: "كلمة كاملة", exact: "مطابق تمامًا" }[k.match_type]}</span>
            <button type="button" aria-label="حذف" className="opacity-70 hover:opacity-100" onClick={() => onChange(keywords.filter((_, j) => j !== k.i))}>✕</button>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Quick setup for a new campaign: post → keyword → message → activate; everything else keeps its defaults. */
const QUICK_IDS = [2, 3, 8, 12];
const QUICK_LABELS = ["المنشور", "الكلمة", "الرسالة", "المراجعة والتفعيل"];

/** Step ids shown: the follow-requirement messages (6, 7) only when the requirement is on. */
const stepIds = (gated: boolean) => (gated ? STEPS.map((_, i) => i) : STEPS.map((_, i) => i).filter((i) => i !== 6 && i !== 7));

export function CampaignWizard({ id }: { id: number | null }) {
  const [form, setForm] = useState<Form>({ ...EMPTY, timezone: currentTz() });
  const [step, setStep] = useState(0);
  const [quick, setQuick] = useState(!id);
  const [loading, setLoading] = useState(!!id);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<number | null>(id);
  const [errors, setErrors] = useState<Array<{ path: string; message: string }>>([]);
  const [media, setMedia] = useState<any[]>([]);
  const [stories, setStories] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [account, setAccount] = useState<any>(null);
  const [testText, setTestText] = useState("أبغى الكورس");
  // A campaign made for a scheduled post (from the scheduling editor): it is linked to that post and turns on by
  // itself once the post is published.
  const [forPost, setForPost] = useState<{ id: number; publish_at?: number } | null>(() => {
    const n = Number(new URLSearchParams(location.hash.split("?")[1] ?? "").get("for_post"));
    return n > 0 ? { id: n } : null;
  });
  const [sim, setSim] = useState<any>(null);
  const [storeItems, setStoreItems] = useState<any[]>([]);

  useEffect(() => {
    if (id) {
      api(`/api/campaigns/${id}`)
        .then((c) => {
          if (c.scheduled_post) setForPost({ id: c.scheduled_post.id, publish_at: c.scheduled_post.publish_at });
          setForm({
            ...EMPTY,
            ...Object.fromEntries(Object.entries(c).filter(([, v]) => v !== null)),
            match_all: !!c.match_all,
            unify_alef: !!c.unify_alef,
            include_replies: !!c.include_replies,
            require_follow: !!c.require_follow,
            follow_invite: !!c.follow_invite,
            public_reply_enabled: !!c.public_reply_enabled,
            process_old_events: !!c.process_old_events,
            track_clicks: c.track_clicks === undefined ? true : !!c.track_clicks,
            follow_reminder_minutes: c.follow_reminder_minutes ?? 0,
            auto_new_media: !!c.auto_new_media,
            auto_new_reels_only: !!c.auto_new_reels_only,
            auto_new_since: c.auto_new_since ?? null,
            schedule_start: c.schedule_start,
            schedule_end: c.schedule_end,
          } as Form);
        })
        .catch((e) => toast(e.message, "bad"))
        .finally(() => setLoading(false));
    }
    if (!id && forPost) setForm((f) => ({ ...f, type: "comment", scope: "selected", media_ids: [], auto_new_media: false, auto_new_since: null }));
    api("/api/media?kind=media").then((r) => setMedia(r.items)).catch(() => undefined);
    api("/api/media?kind=story").then((r) => setStories(r.items)).catch(() => undefined);
    api("/api/templates").then(setTemplates).catch(() => undefined);
    api("/api/store/products").then((r) => setStoreItems(r.items ?? [])).catch(() => undefined);
    api("/api/account").then((r) => setAccount(r.account)).catch(() => undefined);
  }, [id]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const vars = { username: "sara_test", account_username: account?.username ?? "your_account", account_link: `https://www.instagram.com/${account?.username ?? "your_account"}` };
  const isComment = form.type === "comment";
  const ids = quick ? QUICK_IDS : stepIds(form.require_follow);
  const labels = quick ? QUICK_LABELS : ids.map((i) => STEPS[i]);
  // Quick setup does not ask for a name: it is derived from the first keyword (editable later).
  const firstKeyword = form.keywords.find((k) => k.kind === "include")?.keyword;
  const autoName = firstKeyword ? `حملة «${firstKeyword}»` : `حملة ${new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { day: "numeric", month: "long" }).format(new Date())}`;

  const payload = () => ({
    ...form,
    name: form.name.trim() || autoName,
    final_url: form.final_url.trim() || null,
    store_coupon: form.store_coupon.trim() || null,
    stock_action: form.stock_action,
    out_of_stock_text: form.out_of_stock_text.trim() || null,
    opening_text: form.opening_text || null,
    public_reply_fallback_text: form.public_reply_fallback_text || null,
    media_ids: form.scope === "selected" ? form.media_ids : [],
    public_reply_enabled: isComment && form.public_reply_enabled,
    ...(forPost ? { for_scheduled_post: forPost.id, type: "comment" as const, scope: "selected" as const } : {}),
  });

  const save = async (): Promise<number | null> => {
    setSaving(true);
    setErrors([]);
    try {
      const r = savedId
        ? await api<{ id: number; warnings: string[] }>(`/api/campaigns/${savedId}`, { method: "PUT", body: payload() })
        : await api<{ id: number; warnings: string[] }>("/api/campaigns", { body: payload() });
      setSavedId(r.id);
      r.warnings?.forEach((w) => toast(w, "info"));
      toast("تم الحفظ");
      return r.id;
    } catch (e) {
      const err = e as ApiError;
      const friendly = (d: { path: string; message: string }) =>
        d.path.startsWith("media_ids") ? { path: "", message: "معرّف منشور غير صالح في «المعرفات اليدوية» — امسح الخانة واختر المنشور من الصور، أو اختر «جميع المنشورات»." } : d;
      setErrors((err.details ?? [{ path: "", message: err.message }]).map(friendly));
      toast(err.details?.length ? friendly(err.details[0]).message : err.message, "bad");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const localMatch = useMemo(
    () =>
      evaluateMatch(testText, {
        matchAll: form.match_all || (form.type === "story_mention" && !form.keywords.some((k) => k.kind === "include")),
        keywords: form.keywords.map((k) => ({ keyword: k.keyword, kind: k.kind, matchType: k.match_type })),
        normalize: { unifyAlef: form.unify_alef },
      }),
    [testText, form],
  );

  const runSim = async (event: string, script: any, reset = false, text = testText) => {
    const cid = savedId ?? (await save());
    if (!cid) return;
    try {
      setSim(await api("/api/simulate", { body: { campaign_id: cid, event, text, participant: "wizard_tester", script, reset } }));
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };

  if (loading) return <Spinner />;

  const publicVariants = publicReplyVariants(form.public_reply_text);
  const previewPublic = (() => {
    let pool = form.require_follow ? publicVariants.filter((v) => !claimsDelivery(v)) : publicVariants;
    if (!pool.length) pool = SAFE_PUBLIC_REPLIES;
    return renderTemplate(pickVariant(pool, 0), vars);
  })();
  const templatePicker = (kind: string, field: keyof Form) => {
    const list = templates.filter((t) => t.kind === kind);
    if (!list.length) return null;
    return (
      <select className="input mt-1 text-sm" defaultValue="" onChange={(e) => e.target.value && set(field, list.find((t) => String(t.id) === e.target.value)!.body as any)} aria-label="إدراج قالب">
        <option value="">— استخدم قالبًا —</option>
        {list.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    );
  };

  // Appends a saved template as one more phrasing instead of replacing the list.
  const templatePickerAppend = (kind: string, field: keyof Form) => {
    const list = templates.filter((t) => t.kind === kind);
    if (!list.length) return null;
    return (
      <select
        className="input w-auto text-sm"
        value=""
        onChange={(e) => {
          const t = list.find((x) => String(x.id) === e.target.value);
          if (t) set(field, [...publicReplyVariants(String(form[field] ?? "")), t.body].join("\n") as any);
        }}
        aria-label="إضافة قالب كصيغة"
      >
        <option value="">+ من القوالب</option>
        {list.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    );
  };

  const stepBody = () => {
    switch (ids[step]) {
      case 0:
        return (
          <Field label="اسم الحملة" hint="اسم داخلي يساعدك على التمييز بين الحملات.">
            <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="مثال: ريلز الكورس — كلمة كورس" />
          </Field>
        );
      case 1:
        if (forPost) return <Alert tone="info">حملة تعليقات على المنشور المجدول.</Alert>;
        return (
          <div className="space-y-2">
            {(["comment", "story_reply", "story_mention"] as const).map((t) => (
              <label key={t} className={`card flex cursor-pointer items-start gap-3 p-4 ${form.type === t ? "ring-2 ring-brand-600" : ""}`}>
                <input type="radio" name="type" className="mt-1.5" checked={form.type === t} onChange={() => setForm((f) => (f.type === t ? f : { ...f, type: t, media_ids: [], auto_new_media: false, auto_new_since: null }))} />
                <span>
                  <b>{AR_LABELS[t]}</b>
                  <span className="muted block text-sm">
                    {t === "comment" && "عندما يعلّق شخص على منشور أو ريلز. أول رسالة تُرسل كرد خاص (Private Reply) واحد على التعليق."}
                    {t === "story_reply" && "عندما يرد شخص على ستوري برسالة خاصة (حدث رسمي يحمل reply_to.story). الرسالة العادية لا تُعامل كرد ستوري."}
                    {t === "story_mention" && "عندما يشير شخص لحسابك في ستوري ويصل إشعار المراسلة الرسمي. المنشن في منشور أو تعليق عام أو Tag لا يبدأ رسالة خاصة."}
                  </span>
                </span>
              </label>
            ))}
          </div>
        );
      case 2:
        if (forPost)
          return (
            <Alert tone="info">
              هذي الحملة مربوطة بـ<b>منشور مجدول</b>{forPost.publish_at ? ` (${fmtTime(forPost.publish_at)})` : ""}. أول ما ينتشر، تنربط فيه وتتفعّل تلقائيًا — والتعليقات من أول لحظة تنحسب. ما تحتاج تختار منشور.
            </Alert>
          );
        if (form.type === "story_mention") return <Alert tone="info">حملات المنشن تعمل على جميع إشعارات المنشن المؤهلة — لا يوجد نطاق عناصر.</Alert>;
        return (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <button type="button" className={`btn ${form.scope === "all" ? "btn-primary" : "btn-ghost"}`} onClick={() => set("scope", "all")}>
                {isComment ? "جميع المنشورات والريلز" : "جميع ردود الستوري"}
              </button>
              <button type="button" className={`btn ${form.scope === "selected" ? "btn-primary" : "btn-ghost"}`} onClick={() => set("scope", "selected")}>
                {isComment ? "منشورات محددة" : "ستوري محددة"}
              </button>
            </div>
            {form.scope === "selected" && !isComment && (
              <Alert tone="warn">اختيار ستوري محددة يعمل فقط إذا تضمّن الحدث معرّف الستوري. إن لم يتضمّنه ستُتجاهل الردود (سبب: story_not_identifiable). الأوضح استخدام «جميع ردود الستوري».</Alert>
            )}
            {form.scope === "selected" && isComment && (
              <Card className="surface-2">
                <Toggle
                  checked={form.auto_new_media}
                  onChange={(v) => setForm((f) => ({ ...f, auto_new_media: v, auto_new_since: v ? f.auto_new_since ?? Date.now() : null }))}
                  label="اربط تلقائيًا كل منشور/ريل جديد أنشره"
                  description={
                    form.auto_new_media && form.auto_new_since
                      ? `أي منشور تنشره بعد ${fmtTime(form.auto_new_since)} يدخل الحملة تلقائيًا عند أول تعليق عليه — بدون تعديل.`
                      : "أي منشور جديد تنشره من الآن يدخل الحملة تلقائيًا عند أول تعليق عليه. يمكنك أيضًا اختيار منشورات حالية بالأسفل."
                  }
                />
                {form.auto_new_media && (
                  <div className="mt-2">
                    <Toggle checked={form.auto_new_reels_only} onChange={(v) => set("auto_new_reels_only", v)} label="الريلز فقط" description="تجاهل منشورات الصور العادية الجديدة." />
                  </div>
                )}
              </Card>
            )}
            {form.scope === "selected" && (
              <>
                <MediaPicker
                  key={form.type}
                  kind={isComment ? "media" : "story"}
                  media={isComment ? media : stories.filter((m) => !m.expires_at || m.expires_at > Date.now() || form.media_ids.includes(m.media_id))}
                  selected={form.media_ids}
                  onChange={(ids) => set("media_ids", ids)}
                  onRefreshed={(items) => (isComment ? setMedia(items) : setStories(items))}
                />
                <Field label="معرفات يدوية (اختياري — للمتقدمين)" hint="أرقام معرّفات Meta فقط، مفصولة بفاصلة. روابط المنشورات لا تُقبل هنا — اختر المنشور من الصور أعلاه.">
                  <input className="input" dir="ltr" value={form.media_ids.join(",")} onChange={(e) => set("media_ids", e.target.value.split(",").map((s) => s.trim()).filter((s) => /^[0-9A-Za-z_]{1,64}$/.test(s)))} />
                </Field>
              </>
            )}
          </div>
        );
      case 3:
        return (
          <div className="space-y-3">
            <div>
              <div className="font-display mb-2 text-[15px] font-bold">متى يرد النظام؟</div>
              <div className="flex flex-wrap gap-2">
                {([[false, "عند كلمات محددة"], [true, isComment ? "على كل التعليقات" : "على كل الردود"]] as const).map(([v, l]) => (
                  <button key={String(v)} type="button" onClick={() => set("match_all", v)} className={`rounded-2xl border px-5 py-3 text-sm font-bold transition ${form.match_all === v ? "border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-200" : "border-[var(--border)] hover:bg-[var(--surface-2)]"}`}>
                    {l}
                  </button>
                ))}
              </div>
              {form.match_all && <p className="muted mt-2 text-[13px]">أي نص يطابق، مع احترام كلمات الاستثناء.</p>}
            </div>
            {!form.match_all && <div className="font-display -mb-1 text-[15px] font-bold">كلمات التشغيل</div>}
            {!form.match_all && <KeywordEditor kind="include" keywords={form.keywords} onChange={(k) => set("keywords", k)} />}
            <p className="muted text-[13px]">المطابقة تتجاهل التشكيل والتطويل والإيموجي والمسافات الزائدة وحالة الأحرف الإنجليزية.</p>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
              <div className="rounded-2xl border border-[var(--border)] px-4 py-1">
                <Toggle checked={form.unify_alef} onChange={(v) => set("unify_alef", v)} label="توحيد أشكال الألف" description="أ إ آ → ا" />
              </div>
              {isComment && (
                <div className="rounded-2xl border border-[var(--border)] px-4 py-1">
                  <Toggle checked={form.include_replies} onChange={(v) => set("include_replies", v)} label="تشمل الردود المتفرعة" description="افتراضيًا تُتجاهل الردود على تعليقات أخرى" />
                </div>
              )}
            </div>
          </div>
        );
      case 4:
        return (
          <div className="space-y-2">
            <p className="muted text-sm">إذا احتوى النص على أي كلمة استثناء لن تعمل الحملة، حتى في وضع «جميع التعليقات».</p>
            <KeywordEditor kind="exclude" keywords={form.keywords} onChange={(k) => set("keywords", k)} />
          </div>
        );
      case 5: {
        const gateOk = !!account?.follow_gate_allowed;
        const mode = form.require_follow ? "required" : form.follow_invite ? "invite" : "none";
        const setMode = (m: string) => setForm((f) => ({ ...f, require_follow: m === "required", follow_invite: m === "invite" }));
        return (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {([["none", "بدون"], ["invite", "دعوة اختيارية"], ...(gateOk || form.require_follow ? [["required", "شرط إلزامي (حساباتك فقط)"]] : [])] as Array<[string, string]>).map(([k, l]) => (
                <button key={k} type="button" onClick={() => setMode(k)} className={`rounded-2xl border px-4 py-2.5 text-sm font-bold transition ${mode === k ? "border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-200" : "border-[var(--border)] hover:bg-[var(--surface-2)]"}`}>
                  {l}
                </button>
              ))}
            </div>
            {mode === "invite" && (
              <>
                <p className="muted text-sm">يُضاف سطر دعوة وزر «👤 تابعنا» داخل رسالة المحتوى نفسها. المحتوى يوصل للجميع سواء تابع أو لا.</p>
                <Field label="نص الدعوة" hint="اكتبها كدعوة لطيفة، لا كشرط. ممنوع مثل: «تابع عشان يوصلك» أو «المتابعة شرط».">
                  <input className="input" value={form.follow_invite_text} maxLength={300} onChange={(e) => set("follow_invite_text", e.target.value)} />
                </Field>
                {claimsFollowRequired(form.follow_invite_text) && <Alert tone="warn">النص يوحي أن المتابعة شرط للحصول على المحتوى — سياسة Meta تمنع ذلك. اجعلها دعوة اختيارية.</Alert>}
              </>
            )}
            {mode === "required" && !gateOk && <Alert tone="bad">شرط المتابعة غير مسموح لهذا الحساب — سيُحفظ بدونه. فعّله من «الربط» إذا كان حسابك.</Alert>}
            {mode === "required" && (
              <Alert tone="warn">
                ⚠️ معيار Meta للسبام يمنع إلزام الناس بالمتابعة للوصول لمحتوى. هذا الخيار لحساباتك فقط وعلى مسؤوليتك، ولا يظهر لحسابات العملاء.<br />
                • التعليق العام وحده لا يمنح إذن قراءة ملف المستخدم؛ لذلك يُرسل رد خاص تمهيدي ويُطلب من الشخص الرد بـ «ابدأ».<br />
                • «غير معروف» أو خطأ API لا يعني «غير متابع» — ولا يُسلَّم المحتوى.
                {account?.follow_check_support === "unsupported" && <><br /><b>⚠️ التحقق غير متاح حاليًا لهذا الربط: {account.follow_check_note}</b></>}
              </Alert>
            )}
            {mode !== "required" && <Alert tone="info">الدعوة الاختيارية مسموحة في سياسة Meta، وما تحتاج رسائل إضافية ولا تحقق.</Alert>}
          </div>
        );
      }
      case 6:
        if (!form.require_follow || !isComment)
          return <Alert tone="info">{!isComment ? "في ردود/منشن الستوري الشخص راسلك بالفعل، فيتم التحقق مباشرة دون رسالة تمهيدية." : "الرسالة التمهيدية تُستخدم فقط عند اشتراط المتابعة. بدونها يُرسل المحتوى مباشرة في الرد الخاص."}</Alert>;
        return (
          <Field label="الرسالة التمهيدية (رد خاص واحد على التعليق)" hint="بدون المحتوى النهائي. تُرسل كنص فقط؛ إن لم تحتوِ «ابدأ» تُضاف تلقائيًا.">
            <textarea className="input" value={form.opening_text} onChange={(e) => set("opening_text", e.target.value)} />
            {templatePicker("opening", "opening_text")}
          </Field>
        );
      case 7:
        if (!form.require_follow) return <Alert tone="info">فعّل شرط المتابعة لضبط هذه الرسائل.</Alert>;
        return (
          <div className="space-y-4">
            <Field label="رسالة طلب المتابعة" hint="يُضاف زر «تحقّق من المتابعة» عندما يكون مدعومًا، مع بديل نصي «اكتب: تحقق».">
              <textarea className="input" value={form.follow_request_text} onChange={(e) => set("follow_request_text", e.target.value)} />
              {templatePicker("follow_request", "follow_request_text")}
            </Field>
            <Field label="تذكير لطيف (عند تكرار التحقق دون متابعة، وفي التذكير التلقائي)">
              <textarea className="input" value={form.follow_reminder_text} onChange={(e) => set("follow_reminder_text", e.target.value)} />
              {templatePicker("reminder", "follow_reminder_text")}
            </Field>
            <Field label="رسالة تعذر التحقق (unknown / خطأ)">
              <textarea className="input" value={form.verify_error_text} onChange={(e) => set("verify_error_text", e.target.value)} />
              {templatePicker("error", "verify_error_text")}
            </Field>
            <Field
              label="تذكير تلقائي لمن لم يتابع"
              hint="يعيد النظام فحص المتابعة بعد المدة: إن تابع يصله المحتوى تلقائيًا، وإن لم يتابع تصله رسالة «التذكير اللطيف» أعلاه مرة واحدة فقط (داخل نافذة 24 ساعة التي يسمح بها إنستقرام)."
            >
              <select className="input" value={form.follow_reminder_minutes} onChange={(e) => set("follow_reminder_minutes", Number(e.target.value))}>
                {REMINDER_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="حد محاولات التحقق (لكل 24 ساعة)">
                <input className="input" type="number" min={1} max={50} value={form.max_verify_attempts} onChange={(e) => set("max_verify_attempts", Number(e.target.value))} />
              </Field>
              <Field label="الفاصل بين المحاولات (ثانية)" hint="الضغط داخل الفاصل لا يُهمل: يُجدول التحقق لنهايته تلقائيًا. المقترح 10.">
                <input className="input" type="number" min={5} value={form.verify_cooldown_seconds} onChange={(e) => set("verify_cooldown_seconds", Number(e.target.value))} />
              </Field>
            </div>
          </div>
        );
      case 8:
        return (
          <div className="space-y-4">
            <Field label="نص المحتوى النهائي" hint="استخدم {{content_url}} لموضع الرابط. يُخزّن على الخادم ولا يظهر قبل أهلية التسليم.">
              <textarea className="input" value={form.final_text} onChange={(e) => set("final_text", e.target.value)} />
              {templatePicker(form.type === "story_mention" ? "mention" : "final", "final_text")}
            </Field>
            <Field label="رابط المحتوى (https)">
              <input className="input" dir="ltr" value={form.final_url} onChange={(e) => set("final_url", e.target.value)} placeholder="https://..." />
              {storeItems.length > 0 && (
                <select className="input mt-2" value="" onChange={(e) => e.target.value && set("final_url", e.target.value)} aria-label="اختيار منتج من متجرك">
                  <option value="">🛍️ أو اختر منتج من متجرك…</option>
                  {storeItems.filter((p) => p.url).map((p) => <option key={p.product_id} value={p.url}>{p.name}</option>)}
                </select>
              )}
            </Field>
            {storeItems.length > 0 && (
              <Field
                label={<span className="inline-flex items-center gap-1">كود خصم الحملة في متجرك (اختياري) <InfoDot text="أنشئ كود خصم في متجرك (سلة) خاص بهذي الحملة واكتبه هنا، وحطه في نص الرسالة. أي طلب يستخدم الكود ينحسب لهذي الحملة في «تحليل المتجر» — وهذي أدق طريقة تعرف فيها كم طلب ومبيعات جابت الحملة." /></span>}
                hint="مثال: REEL18 — حروف إنجليزية وأرقام."
              >
                <input className="input" dir="ltr" value={form.store_coupon} onChange={(e) => set("store_coupon", e.target.value.replace(/[^A-Za-z0-9_-]/g, "").toUpperCase())} placeholder="REEL18" maxLength={60} />
              </Field>
            )}
            {storeItems.some((p) => p.url && p.url === form.final_url) && (
              <Field
                label={<span className="inline-flex items-center gap-1">لو خلص المنتج من المخزون <InfoDot text="النظام يعرف من متجرك لما ينفد المنتج أو يرجع، ويبلغك على تيليجرام. «قائمة انتظار»: بدل الرابط ترد الحملة إن المنتج خلص وتطلب منه يكتب «بلغني» — ولما يرجع نرسل له رسالة واحدة، بشرط إنه كتب لنا خلال آخر 24 ساعة (قاعدة إنستقرام: ما نقدر نراسل أحد بعد 24 ساعة من آخر رسالة منه)." /></span>}
              >
                <div className="seg grid w-full grid-cols-3 !overflow-visible" role="group" aria-label="لو خلص المنتج">
                  {([["notify", "أبلغني بس"], ["pause", "أوقف الحملة"], ["waitlist", "قائمة انتظار"]] as const).map(([k, l]) => (
                    <button key={k} type="button" aria-pressed={form.stock_action === k} className={`text-center ${form.stock_action === k ? "on" : ""}`} onClick={() => set("stock_action", k)}>{l}</button>
                  ))}
                </div>
                <p className="muted mt-1.5 text-xs">
                  {form.stock_action === "notify" ? "الحملة تكمل ترسل الرابط عادي، ويوصلك تنبيه." : form.stock_action === "pause" ? "الحملة تتوقف مؤقتًا لما ينفد، وترجع تشتغل لحالها لما يتوفر." : "الحملة ترد إن المنتج خلص وتعرض التنبيه، ولما يرجع نرسل لمن كتب «بلغني» (خلال 24 ساعة من رسالته)."}
                </p>
                {form.stock_action === "waitlist" && (
                  <textarea className="input mt-2" value={form.out_of_stock_text} onChange={(e) => set("out_of_stock_text", e.target.value)} maxLength={1000}
                    placeholder={"هلا {{username|يا غالي}} 🌸 للأسف المنتج خلص حاليًا من المخزون.\nتبغى نبلغك أول ما يرجع؟ رد بكلمة: بلغني"} />
                )}
              </Field>
            )}
            <Toggle
              checked={form.track_clicks}
              onChange={(v) => set("track_clicks", v)}
              label="تتبّع الضغط على الرابط"
              description="يُرسل الرابط كزر «فتح الرابط 🔗» يمر عبر خادمك أولًا فيُحسب الضغط ثم يُحوَّل فورًا للرابط الأصلي. تظهر الأرقام وأسماء من ضغطوا في الإحصائيات."
            />
            <div className="muted text-xs">المتغيرات المتاحة: {Object.entries(TEMPLATE_VARIABLES).map(([k, v]) => `{{${k}}} — ${v}`).join(" · ")}. مثال بديل: {"{{username|يا غالي}}"}</div>
          </div>
        );
      case 9:
        if (!isComment) return <Alert tone="info">الرد العام متاح لحملات التعليقات فقط.</Alert>;
        return (
          <div className="space-y-3">
            <Toggle checked={form.public_reply_enabled} onChange={(v) => set("public_reply_enabled", v)} label="رد عام على التعليق" description="يُنشر فقط بعد قبول Meta للرد الخاص." />
            {form.public_reply_enabled && (
              <>
                <Field
                  label={`صيغ الرد العام (${publicVariants.length} من ${MAX_PUBLIC_VARIANTS})`}
                  hint="اكتب كل صيغة في سطر مستقل. يختار النظام صيغة مختلفة لكل تعليق بالتناوب حتى لا تتكرر نفس الجملة فيعتبرها إنستقرام سبام. ننصح بـ 4 صيغ أو أكثر، ويمكن استخدام {{username}} لتمييز كل رد."
                >
                  <textarea
                    className="input min-h-[140px]"
                    value={form.public_reply_text}
                    onChange={(e) => set("public_reply_text", e.target.value)}
                    placeholder={SAFE_PUBLIC_REPLIES.join("\n")}
                  />
                  <div className="mt-1 flex flex-wrap gap-2">
                    <button type="button" className="btn btn-ghost text-sm" onClick={() => set("public_reply_text", [...new Set([...publicVariants, ...SAFE_PUBLIC_REPLIES])].slice(0, MAX_PUBLIC_VARIANTS).join("\n"))}>
                      + أضف صيغًا جاهزة
                    </button>
                    {templatePickerAppend("public", "public_reply_text")}
                  </div>
                </Field>
                {publicVariants.length === 1 && <Alert tone="warn">صيغة واحدة فقط ستتكرر تحت كل التعليقات. أضف صيغًا أخرى (سطر لكل صيغة).</Alert>}
                {form.require_follow && publicVariants.some((v) => claimsDelivery(v)) && (
                  <Alert tone="warn">بعض الصيغ تدّعي الإرسال (مثل «أرسلت لك»). لن تُستخدم قبل التسليم الفعلي، وتُستخدم بدلها الصيغ الأخرى أو صيغ محايدة.</Alert>
                )}
                <Field label="إذا فشل الرد الخاص">
                  <select className="input" value={form.public_reply_on_dm_fail} onChange={(e) => set("public_reply_on_dm_fail", e.target.value as any)}>
                    <option value="none">لا ترد علنًا</option>
                    <option value="fallback">رد بنص بديل (بدون ادعاء الإرسال)</option>
                  </select>
                </Field>
                {form.public_reply_on_dm_fail === "fallback" && (
                  <Field label="النص البديل">
                    <textarea className="input min-h-[90px]" value={form.public_reply_fallback_text} onChange={(e) => set("public_reply_fallback_text", e.target.value)} placeholder={"راسلنا على الخاص 🙏\nأرسل لنا رسالة خاصة 💬"} />
                  </Field>
                )}
              </>
            )}
          </div>
        );
      case 10:
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3">
              <Field label={`بداية التشغيل — اختياري (${form.timezone})`} hint={form.schedule_start ? `تبدأ ${fmtTime(form.schedule_start, form.timezone)}` : undefined}>
                <DateTimeField label="بداية التشغيل" emptyLabel="بدون — تبدأ من التفعيل" value={utcToLocalInput(form.schedule_start, form.timezone)} onChange={(v) => set("schedule_start", localInputToUtc(v, form.timezone))} />
              </Field>
              <Field label={`نهاية التشغيل — اختياري (${form.timezone})`} hint={form.schedule_end ? `تتوقف ${fmtTime(form.schedule_end, form.timezone)}` : undefined}>
                <DateTimeField label="نهاية التشغيل" emptyLabel="بدون — تستمر لين توقفها" value={utcToLocalInput(form.schedule_end, form.timezone)} onChange={(v) => set("schedule_end", localInputToUtc(v, form.timezone))} />
              </Field>
            </div>
            <p className="surface-2 rounded-xl px-3 py-2.5 text-sm text-[var(--text-2)]">
              {!form.schedule_start && !form.schedule_end
                ? "ما حددت تاريخ: الحملة تشتغل طول ما هي «نشطة»، من لحظة تفعيلها لين توقفها بنفسك."
                : form.schedule_start && form.schedule_end
                  ? `الحملة ترد على التعليقات من ${fmtTime(form.schedule_start, form.timezone)} إلى ${fmtTime(form.schedule_end, form.timezone)} فقط. خارج هالفترة ما ترد على أحد.`
                  : form.schedule_start
                    ? `الحملة ترد على التعليقات من ${fmtTime(form.schedule_start, form.timezone)}، وتستمر لين توقفها أنت.`
                    : `الحملة ترد من لحظة تفعيلها لين ${fmtTime(form.schedule_end!, form.timezone)}، وبعدها ما ترد على أحد.`}
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="الأولوية" hint="عند تطابق عدة حملات تُنفَّذ الأعلى فقط.">
                <input className="input" type="number" min={0} max={1000} value={form.priority} onChange={(e) => set("priority", Number(e.target.value))} />
              </Field>
              <Field label="فاصل لكل مستخدم (ساعات)" hint="0 = بدون فاصل">
                <input className="input" type="number" min={0} value={form.per_user_cooldown_hours} onChange={(e) => set("per_user_cooldown_hours", Number(e.target.value))} />
              </Field>
              <Field label="أقصى تسليم لكل مستخدم" hint="0 = بلا حد">
                <input className="input" type="number" min={0} value={form.max_deliveries_per_user} onChange={(e) => set("max_deliveries_per_user", Number(e.target.value))} />
              </Field>
            </div>
            <Toggle checked={form.process_old_events} onChange={(v) => set("process_old_events", v)} label="معالجة الأحداث الأقدم من وقت التفعيل" description="افتراضيًا تُتجاهل." />
          </div>
        );
      case 11: {
        const link = form.final_url || "";
        const strip = (t: string) => (link ? t.split(link).join("") : t);
        const previews: Array<[string, string]> = [];
        if (form.require_follow && isComment) previews.push(["رد خاص تمهيدي", strip(renderTemplate(form.opening_text, vars))]);
        if (form.require_follow) {
          previews.push(["طلب المتابعة", strip(renderTemplate(form.follow_request_text, vars))]);
          previews.push(["تذكير", strip(renderTemplate(form.follow_reminder_text, vars))]);
        }
        previews.push(["المحتوى النهائي", renderTemplate(form.final_text, { ...vars, content_url: link }) + (link && !form.final_text.includes("{{content_url}}") ? `\n${link}` : "")]);
        if (isComment && form.public_reply_enabled) previews.push([`الرد العام${publicVariants.length > 1 ? ` (1 من ${publicVariants.length} صيغ بالتناوب)` : ""}`, previewPublic]);
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              {previews.map(([t, body]) => (
                <div key={t} className="surface-2 rounded-xl p-3">
                  <div className="muted text-xs font-bold">{t}</div>
                  <div className="whitespace-pre-wrap">{body}</div>
                </div>
              ))}
            </div>
            <Card title="محاكاة (وضع تجريبي — لا يُرسل شيء حقيقي)">
              <Field label="نص الحدث التجريبي"><input className="input" value={testText} onChange={(e) => setTestText(e.target.value)} /></Field>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="btn btn-ghost" onClick={() => runSim(form.type, { follow: ["following"] }, true)}>حدث + متابع</button>
                {form.require_follow && <button type="button" className="btn btn-ghost" onClick={() => runSim(form.type, { follow: ["not_following", "following"] }, true)}>حدث + غير متابع</button>}
                {form.require_follow && isComment && <button type="button" className="btn btn-ghost" onClick={() => runSim("message", undefined, false, "ابدأ")}>الشخص يرد «ابدأ»</button>}
                {form.require_follow && <button type="button" className="btn btn-ghost" onClick={() => runSim("verify_button", undefined)}>الشخص يضغط «تحقّق»</button>}
              </div>
              {sim && <SimResult sim={sim} />}
              <p className="muted mt-2 text-xs">لتجربة سيناريوهات أكثر (فشل، تأخر، انتهاء النافذة) استخدم صفحة «المحاكاة». ملاحظة: الفاصل بين محاولات التحقق مطبّق في المحاكاة أيضًا.</p>
            </Card>
          </div>
        );
      }
      case 12:
        return (
          <div className="space-y-3">
            {quick && (
              <Field label="اسم الحملة (اختياري)" hint="اسم داخلي تشوفه أنت فقط.">
                <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder={autoName} />
              </Field>
            )}
            {quick && (
              <div className="surface-2 space-y-1 rounded-xl p-3 text-sm">
                <div><span className="muted">المنشور: </span>{forPost ? "المنشور المجدول (يتربط عند النشر)" : form.scope === "all" ? "جميع المنشورات والريلز" : `${form.media_ids.length} منشور محدد`}</div>
                <div><span className="muted">الكلمات: </span>{form.match_all ? "أي تعليق" : form.keywords.filter((k) => k.kind === "include").map((k) => k.keyword).join("، ") || "— لم تُحدد كلمة"}</div>
                <div><span className="muted">الرابط: </span><span dir="ltr">{form.final_url || "—"}</span></div>
              </div>
            )}
            {!account || account.status !== "active" ? <Alert tone="warn">لا يوجد حساب متصل ونشط — يمكنك الحفظ كمسودة، لكن التفعيل لن يعالج أحداثًا حقيقية قبل الربط.</Alert> : null}
            {forPost ? (
              <>
                <Alert tone="info">الحملة تنحفظ الحين وتتفعّل تلقائيًا أول ما ينتشر المنشور المجدول. بعد الحفظ نرجعك للمنشور عشان تكمل جدولته.</Alert>
                <button
                  className="btn btn-primary"
                  disabled={saving}
                  onClick={async () => {
                    const cid = await save();
                    if (!cid) return;
                    toast("تم حفظ الحملة وربطها بالمنشور ✅");
                    navigate(`/schedule?post=${forPost.id}`);
                  }}
                >
                  حفظ وربطها بالمنشور
                </button>
              </>
            ) : (
            <>
            <p>بعد التفعيل تُعالج الأحداث الجديدة فقط (الأحدث من لحظة التفعيل) ما لم تختر غير ذلك.</p>
            <div className="flex flex-wrap gap-2">
              <button
                className="btn btn-primary"
                disabled={saving}
                onClick={async () => {
                  const cid = await save();
                  if (!cid) return;
                  await api(`/api/campaigns/${cid}/status`, { body: { status: "active" } });
                  toast("تم تفعيل الحملة ✅");
                  navigate("/campaigns");
                }}
              >
                حفظ وتفعيل
              </button>
              <button className="btn btn-ghost" disabled={saving} onClick={async () => (await save()) && navigate("/campaigns")}>حفظ كمسودة</button>
            </div>
            </>
            )}
          </div>
        );
    }
  };

  // ---- live phone preview (nothing is sent) ----
  const link = form.final_url || "";
  const strip = (t: string) => (link ? t.split(link).join("") : t);
  const contentText = renderTemplate(form.final_text || "تفضل 🎁 {{content_url}}", { ...vars, content_url: link }) + (link && !form.final_text.includes("{{content_url}}") ? `\n${link}` : "");
  const sampleText = testText || "أبغى الكورس";
  // The content link is delivered as a tappable button (Instagram does not open bare links in a first message).
  const contentBtn = contentLinkButton(contentText, form.final_url || null);
  const invite = !form.require_follow && form.follow_invite ? form.follow_invite_text.trim() || "ونسعد بمتابعتك لحسابنا 💜" : "";
  const contentMsg = (note?: string): ChatMsg => ({
    from: "bot",
    text: [contentBtn?.text ?? contentText, invite].filter(Boolean).join("\n\n"),
    buttons: [...(contentBtn ? [contentBtn.title] : []), ...(invite ? ["👤 تابعنا"] : [])],
    note,
  });
  const dm: ChatMsg[] = [];
  if (form.type === "story_reply") dm.push({ from: "user", text: `↩️ ردّ على قصتك\n${sampleText}` });
  if (form.type === "story_mention") dm.push({ from: "user", text: "📣 أشار إليك في قصته" });
  if (form.require_follow) {
    if (isComment) {
      const opening = strip(renderTemplate(form.opening_text || "حياك الله 🙌 رد بكلمة ابدأ", vars));
      dm.push({ from: "bot", text: opening, buttons: ["ابدأ"], note: "رد خاص على التعليق" });
      dm.push({ from: "user", text: "ابدأ" });
    }
    // The account link is sent as an «افتح حسابنا» button (see sendAccountButtons), not as text.
    const followText = strip(renderTemplate(form.follow_request_text, vars)).split(vars.account_link).join("").replace(/[ \t]{2,}/g, " ").trim();
    dm.push({ from: "bot", text: followText, buttons: ["👤 افتح حسابنا", "تحقّق من المتابعة"] });
    dm.push({ from: "user", text: "تحقّق من المتابعة" });
    dm.push(contentMsg("بعد تأكيد المتابعة من Meta"));
  } else {
    dm.push(contentMsg(isComment ? "رد خاص على التعليق" : undefined));
  }
  const comments: CommentMsg[] = isComment
    ? [
        { username: "sara_test", text: sampleText },
        ...(form.public_reply_enabled
          ? [{ username: account?.username ?? "your_account", isOwner: true, text: previewPublic }]
          : []),
      ]
    : [];
  const selected = (isComment ? media : stories).find((m) => form.media_ids.includes(m.media_id));
  const preview = (
    <PhonePreview
      key={form.type}
      accountUsername={account?.username ?? "your_account"}
      avatarUrl={account?.profile_picture_url}
      postImage={isComment || form.type === "story_reply" ? selected?.thumbnail_url : null}
      postCaption={isComment ? selected?.caption : form.type === "story_reply" ? "📱 قصتك" : "📣 قصة أشار فيها إليك أحدهم"}
      comments={comments}
      dm={dm}
      defaultTab="dm"
      footnote="معاينة مباشرة تتحدث أثناء التعديل — لا يُرسل شيء."
    />
  );

  // Match test samples: a sentence with each trigger word, and each exclusion word as a question.
  const includes = form.keywords.filter((k) => k.kind === "include").slice(0, 3).map((k) => `أبغى ${k.keyword}`);
  const excludes = form.keywords.filter((k) => k.kind === "exclude").slice(0, 2).map((k) => `${k.keyword}؟`);
  const samples = [...includes, ...excludes].map((t) => ({
    t,
    ok: evaluateMatch(t, {
      matchAll: form.match_all,
      keywords: form.keywords.map((k) => ({ keyword: k.keyword, kind: k.kind, matchType: k.match_type })),
      normalize: { unifyAlef: form.unify_alef },
    }).matched,
  }));
  const tryInSimulator = async () => {
    const cid = await save();
    if (cid) navigate(`/simulator?campaign=${cid}`);
  };
  const next = () => setStep((st) => Math.min(labels.length - 1, st + 1));

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <nav className="muted flex items-center gap-1.5 text-sm" aria-label="المسار">
            <button className="hover:underline" onClick={() => navigate("/campaigns")}>الحملات</button>
            <Icon name="chev" size={14} className="rotate-90" />
            <span>{id ? "تعديل حملة" : "حملة جديدة"}</span>
          </nav>
          <h1 className="mt-1 truncate text-2xl font-extrabold leading-tight sm:text-[28px]">{form.name.trim() || (id ? "تعديل حملة" : "حملة جديدة")}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ghost" onClick={save} disabled={saving}>{saving ? "جارٍ الحفظ…" : "حفظ كمسودة"}</button>
          <button className="btn btn-ghost" onClick={tryInSimulator} disabled={saving}><Icon name="flask" size={18} />جرّب في المحاكاة</button>
          {step < labels.length - 1 ? (
            <button className="btn btn-primary max-lg:!hidden" onClick={next}>التالي<Icon name="arrowL" size={18} /></button>
          ) : null}
        </div>
      </header>

      {!id && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="seg" role="group" aria-label="طريقة الإعداد">
            <button type="button" aria-pressed={quick} className={quick ? "on" : ""} onClick={() => { setQuick(true); setStep(0); }}>إعداد سريع</button>
            <button type="button" aria-pressed={!quick} className={!quick ? "on" : ""} onClick={() => { setQuick(false); setStep(0); }}>كل الإعدادات</button>
          </div>
          <span className="muted text-xs">{quick ? "4 خطوات، والباقي بقيم افتراضية آمنة تقدر تعدّلها لاحقًا." : "كل الخيارات: النوع، الاستثناءات، الرد العام، الجدولة، والمزيد."}</span>
        </div>
      )}

      {/* phones: compact horizontal step list */}
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 lg:hidden" role="tablist" aria-label="الخطوات">
        {labels.map((label, i) => (
          <button key={i} role="tab" aria-selected={i === step} onClick={() => setStep(i)} className={`flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold ${i === step ? "border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-200" : "border-[var(--border)] muted"}`}>
            <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${i === step ? "grad text-white" : i < step ? "bg-emerald-500/15 text-emerald-600" : "surface-2"}`}>{i < step ? "✓" : i + 1}</span>
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[250px_minmax(0,1fr)] xl:grid-cols-[250px_minmax(0,1fr)_330px]">
        <nav className="card hidden h-fit p-3 lg:sticky lg:top-20 lg:block" aria-label="الخطوات">
          <ol className="space-y-1">
            {labels.map((label, i) => (
              <li key={i}>
                <button onClick={() => setStep(i)} className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-right text-sm font-bold transition ${i === step ? "bg-violet-500/10 text-violet-700 dark:text-violet-200" : i < step ? "" : "muted hover:bg-[var(--surface-2)]"}`}>
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs ${i === step ? "grad text-white shadow-md shadow-violet-500/30" : i < step ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "surface-2 muted"}`}>
                    {i < step ? <Icon name="check" size={14} /> : i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <div className="min-w-0 space-y-5">
          {errors.length > 0 && (
            <Alert tone="bad">
              <ul className="list-inside list-disc">{errors.map((e, i) => <li key={i}>{e.message}{e.path ? ` (${e.path})` : ""}</li>)}</ul>
            </Alert>
          )}
          <Card title={labels[step]} action={<span className="chip bg-violet-500/10 text-violet-700 dark:text-violet-200">الخطوة {step + 1} من {labels.length}</span>}>
            {stepBody()}
          </Card>
          {(step === 3 || step === 4) && (
            <Card title={<span className="flex flex-wrap items-baseline gap-x-3">اختبار المطابقة <span className="muted text-[13px] font-normal">اكتب تعليقًا وشوف النتيجة فورًا</span></span>}>
              <div className="relative">
                <input className="input pl-36" value={testText} onChange={(e) => setTestText(e.target.value)} aria-label="نص التجربة" />
                <span className={`chip absolute left-3 top-1/2 -translate-y-1/2 ${localMatch.matched ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"}`}>
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  {localMatch.matched ? `يطابق «${localMatch.keyword ?? "الكل"}»` : "لا يطابق"}
                </span>
              </div>
              {!localMatch.matched && localMatch.reason && <div className="muted mt-2 text-xs">السبب: {localMatch.reason}</div>}
              {samples.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {samples.map((x) => (
                    <button key={x.t} type="button" onClick={() => setTestText(x.t)} className={`chip ${x.ok ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"}`}>
                      {x.ok ? "✓" : "✗"} «{x.t}»
                    </button>
                  ))}
                </div>
              )}
            </Card>
          )}
          <div className="flex justify-between gap-2">
            <button className="btn btn-ghost" disabled={step === 0} onClick={() => setStep((st) => st - 1)}><Icon name="arrowL" size={18} className="rotate-180" />السابق</button>
            {step < labels.length - 1 && <button className="btn btn-primary" onClick={next}>التالي<Icon name="arrowL" size={18} /></button>}
          </div>
        </div>

        <aside className="lg:col-span-2 xl:sticky xl:top-20 xl:col-span-1 xl:self-start">{preview}</aside>
      </div>
    </div>
  );
}

export function SimResult({ sim }: { sim: any }) {
  if (!sim.ok) return <div className="mt-3"><Alert tone="warn">{sim.error}</Alert></div>;
  return (
    <div className="mt-3 space-y-2 text-sm">
      <div>
        الحدث: <b>{AR_LABELS[sim.event?.event_type] ?? sim.event?.event_type}</b> — <span className="muted">{sim.event?.status} · {sim.event?.reason}</span>
      </div>
      {sim.flows[0] && (
        <div>
          حالة المسار: <b>{AR_LABELS[sim.flows[0].state] ?? sim.flows[0].state}</b>
          {sim.flows[0].last_follow_result && <> · آخر تحقق: {AR_LABELS[sim.flows[0].last_follow_result] ?? sim.flows[0].last_follow_result}</>}
        </div>
      )}
      <ol className="space-y-2">
        {sim.jobs.filter((j: any) => j.kind !== "process_event").map((j: any) => (
          <li key={j.id} className="surface-2 rounded-lg p-2">
            <div className="muted text-xs">
              {j.kind === "send_message" ? (j.result?.channel === "private_reply" ? "رد خاص" : "رسالة خاصة") : j.kind === "public_reply" ? "رد عام" : "تحقق من المتابعة"} · {j.purpose ?? ""} · <b>{AR_LABELS[j.status] ?? j.status}</b>
              {j.last_error ? ` · ${j.last_error}` : ""}
            </div>
            {j.result?.text && <div className="whitespace-pre-wrap">{j.result.text}</div>}
            {j.result?.quick_replies?.length ? <div className="mt-1 flex gap-1">{j.result.quick_replies.map((q: any) => <span key={q.title} className="rounded-full border px-2 text-xs">{q.title}</span>)}</div> : null}
            {j.result?.follow && <div>النتيجة: {AR_LABELS[j.result.follow] ?? j.result.follow}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}
