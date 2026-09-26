import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { navigate } from "../App";
import { renderTemplate, claimsDelivery, contentLinkButton, publicReplyVariants, pickVariant, SAFE_PUBLIC_REPLIES, MAX_PUBLIC_VARIANTS, TEMPLATE_VARIABLES } from "../../shared/template";
import { evaluateMatch } from "../../shared/match";
import { AR_LABELS } from "../../shared/states";
import { Alert, Card, Field, PageHeader, Spinner, Toggle, currentTz, toast } from "../components/ui";
import { PhonePreview, type ChatMsg, type CommentMsg } from "../components/PhonePreview";

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
  opening_text: "حياك الله 🙌 رد بكلمة ابدأ عشان أتحقق من المتابعة وأرسل لك المحتوى.",
  follow_request_text: "باقي خطوة بسيطة 🔥 تابع حسابنا {{account_link}} ثم ارجع هنا واضغط «تحقّق من المتابعة» عشان أوصلك المحتوى.",
  follow_reminder_text: "لسا ما ظهرت لنا متابعتك 🙏 تأكد إنك تابعت {{account_link}} ثم جرّب «تحقق» بعد دقيقة.",
  verify_error_text: "ما قدرنا نتحقق من المتابعة الآن ⏳ جرّب تكتب «تحقق» بعد شوي.",
  final_text: "تفضل 🎁 {{content_url}}",
  final_url: "",
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
};

const STEPS = [
  "اسم الحملة",
  "نوع الحدث",
  "نطاق التشغيل",
  "الكلمات والشروط",
  "استثناءات المطابقة",
  "شرط المتابعة",
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

function MediaPicker({ media, selected, onChange, onRefreshed }: { media: any[]; selected: string[]; onChange: (ids: string[]) => void; onRefreshed: (items: any[]) => void }) {
  const [filter, setFilter] = useState<MediaFilter>("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try {
      const r = await api<{ count: number }>("/api/media/refresh", { body: { kind: "media", all: true } });
      const m = await api("/api/media?kind=media");
      onRefreshed(m.items);
      toast(`تم جلب ${r.count} منشور`);
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const isReel = (m: any) => m.media_product_type === "REELS";
  const list = media.filter(
    (m) => (filter === "all" || (filter === "reels" ? isReel(m) : !isReel(m))) && (!q.trim() || (m.caption ?? "").toLowerCase().includes(q.trim().toLowerCase())),
  );
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary" onClick={refresh} disabled={busy}>{busy ? "جارٍ الجلب…" : media.length ? "🔄 تحديث منشوراتي" : "جلب منشوراتي من إنستقرام"}</button>
        <div className="surface-2 flex rounded-xl p-1 text-sm" role="tablist">
          {([["all", "الكل"], ["reels", "ريلز"], ["posts", "منشورات"]] as const).map(([k, v]) => (
            <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)} className={`rounded-lg px-3 py-1.5 font-semibold ${filter === k ? "bg-[var(--surface)] shadow" : "muted"}`}>{v}</button>
          ))}
        </div>
        <span className="muted text-sm">{list.length} عنصر · المحدد: {selected.length}</span>
      </div>
      {media.length > 0 && <input className="input" placeholder="بحث في وصف المنشور…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث في المنشورات" />}
      {!media.length && !busy && <Alert tone="info">لم تُجلب منشوراتك بعد — اضغط «جلب منشوراتي».</Alert>}
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
          <span key={k.i} className="surface-2 inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm">
            {k.keyword} <span className="muted text-xs">({{ contains: "يحتوي", word: "كلمة كاملة", exact: "كامل" }[k.match_type]})</span>
            <button type="button" aria-label="حذف" onClick={() => onChange(keywords.filter((_, j) => j !== k.i))}>✕</button>
          </span>
        ))}
      </div>
    </div>
  );
}

export function CampaignWizard({ id }: { id: number | null }) {
  const [form, setForm] = useState<Form>({ ...EMPTY, timezone: currentTz() });
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(!!id);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<number | null>(id);
  const [errors, setErrors] = useState<Array<{ path: string; message: string }>>([]);
  const [media, setMedia] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [account, setAccount] = useState<any>(null);
  const [testText, setTestText] = useState("أبغى الكورس");
  const [sim, setSim] = useState<any>(null);

  useEffect(() => {
    if (id) {
      api(`/api/campaigns/${id}`)
        .then((c) =>
          setForm({
            ...EMPTY,
            ...Object.fromEntries(Object.entries(c).filter(([, v]) => v !== null)),
            match_all: !!c.match_all,
            unify_alef: !!c.unify_alef,
            include_replies: !!c.include_replies,
            require_follow: !!c.require_follow,
            public_reply_enabled: !!c.public_reply_enabled,
            process_old_events: !!c.process_old_events,
            schedule_start: c.schedule_start,
            schedule_end: c.schedule_end,
          } as Form),
        )
        .catch((e) => toast(e.message, "bad"))
        .finally(() => setLoading(false));
    }
    api("/api/media?kind=media").then((r) => setMedia(r.items)).catch(() => undefined);
    api("/api/templates").then(setTemplates).catch(() => undefined);
    api("/api/account").then((r) => setAccount(r.account)).catch(() => undefined);
  }, [id]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const vars = { username: "sara_test", account_username: account?.username ?? "your_account", account_link: `https://www.instagram.com/${account?.username ?? "your_account"}` };
  const isComment = form.type === "comment";

  const payload = () => ({
    ...form,
    final_url: form.final_url.trim() || null,
    opening_text: form.opening_text || null,
    public_reply_fallback_text: form.public_reply_fallback_text || null,
    media_ids: form.scope === "selected" ? form.media_ids : [],
    public_reply_enabled: isComment && form.public_reply_enabled,
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
      toast(err.message, "bad");
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
    switch (step) {
      case 0:
        return (
          <Field label="اسم الحملة" hint="اسم داخلي يساعدك على التمييز بين الحملات.">
            <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="مثال: ريلز الكورس — كلمة كورس" />
          </Field>
        );
      case 1:
        return (
          <div className="space-y-2">
            {(["comment", "story_reply", "story_mention"] as const).map((t) => (
              <label key={t} className={`card flex cursor-pointer items-start gap-3 p-4 ${form.type === t ? "ring-2 ring-brand-600" : ""}`}>
                <input type="radio" name="type" className="mt-1.5" checked={form.type === t} onChange={() => set("type", t)} />
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
        if (form.type === "story_mention") return <Alert tone="info">حملات المنشن تعمل على جميع إشعارات المنشن المؤهلة — لا يوجد نطاق عناصر.</Alert>;
        return (
          <div className="space-y-3">
            <div className="flex gap-2">
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
            {form.scope === "selected" && (
              <>
                <MediaPicker
                  media={media}
                  selected={form.media_ids}
                  onChange={(ids) => set("media_ids", ids)}
                  onRefreshed={(items) => setMedia(items)}
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
            <Toggle checked={form.match_all} onChange={(v) => set("match_all", v)} label={isComment ? "تشغيل على جميع التعليقات" : "تشغيل على جميع الردود"} description="خيار صريح: أي نص يطابق (مع احترام الاستثناءات)." />
            {!form.match_all && <KeywordEditor kind="include" keywords={form.keywords} onChange={(k) => set("keywords", k)} />}
            <Toggle checked={form.unify_alef} onChange={(v) => set("unify_alef", v)} label="توحيد أشكال الألف (أ إ آ → ا)" description="التشكيل والتطويل والمسافات الزائدة وحالة الأحرف الإنجليزية تُتجاهل دائمًا." />
            {isComment && <Toggle checked={form.include_replies} onChange={(v) => set("include_replies", v)} label="تشمل الردود المتفرعة داخل التعليقات" description="افتراضيًا تُتجاهل الردود على تعليقات أخرى." />}
            <Card className="surface-2">
              <Field label="اختبار المطابقة محليًا">
                <input className="input" value={testText} onChange={(e) => setTestText(e.target.value)} />
              </Field>
              <div className="mt-2 text-sm">{localMatch.matched ? `✅ يطابق (${localMatch.keyword ?? "الكل"})` : `❌ لا يطابق (${localMatch.reason})`}</div>
            </Card>
          </div>
        );
      case 4:
        return (
          <div className="space-y-2">
            <p className="muted text-sm">إذا احتوى النص على أي كلمة استثناء لن تعمل الحملة، حتى في وضع «جميع التعليقات».</p>
            <KeywordEditor kind="exclude" keywords={form.keywords} onChange={(k) => set("keywords", k)} />
          </div>
        );
      case 5:
        return (
          <div className="space-y-3">
            <Toggle checked={form.require_follow} onChange={(v) => set("require_follow", v)} label="اشترط متابعة حسابي قبل إرسال المحتوى" description="لا يُرسل الرابط أو الكود أو المحتوى النهائي قبل تحقق فعلي عبر User Profile API (الحقل is_user_follow_business)." />
            {form.require_follow && (
              <Alert tone="info">
                • التعليق العام وحده لا يمنح إذن قراءة ملف المستخدم؛ لذلك يُرسل رد خاص تمهيدي واحد ويُطلب من الشخص الرد بـ «ابدأ».<br />
                • الضغط على «تابعت» أو فتح رابط الحساب ليس دليلًا — يُنفَّذ استعلام جديد في كل مرة.<br />
                • «غير معروف» أو خطأ API لا يعني «غير متابع» — ولا يُسلَّم المحتوى.<br />
                • لا يوجد إشعار رسمي عند المتابعة؛ الشخص يعود ويضغط «تحقّق».<br />
                • اشتراط المتابعة لا يمنع مشاركة الرابط بعد استلامه.
                {account?.follow_check_support === "unsupported" && <><br /><b>⚠️ التحقق غير متاح حاليًا لهذا الربط: {account.follow_check_note}</b></>}
              </Alert>
            )}
          </div>
        );
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
            <Field label="تذكير لطيف (عند تكرار التحقق دون متابعة)">
              <textarea className="input" value={form.follow_reminder_text} onChange={(e) => set("follow_reminder_text", e.target.value)} />
              {templatePicker("reminder", "follow_reminder_text")}
            </Field>
            <Field label="رسالة تعذر التحقق (unknown / خطأ)">
              <textarea className="input" value={form.verify_error_text} onChange={(e) => set("verify_error_text", e.target.value)} />
              {templatePicker("error", "verify_error_text")}
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
            </Field>
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={`بداية التشغيل (${form.timezone})`}>
                <input className="input" type="datetime-local" value={utcToLocalInput(form.schedule_start, form.timezone)} onChange={(e) => set("schedule_start", localInputToUtc(e.target.value, form.timezone))} />
              </Field>
              <Field label={`نهاية التشغيل (${form.timezone})`}>
                <input className="input" type="datetime-local" value={utcToLocalInput(form.schedule_end, form.timezone)} onChange={(e) => set("schedule_end", localInputToUtc(e.target.value, form.timezone))} />
              </Field>
            </div>
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
            {!account || account.status !== "active" ? <Alert tone="warn">لا يوجد حساب متصل ونشط — يمكنك الحفظ كمسودة، لكن التفعيل لن يعالج أحداثًا حقيقية قبل الربط.</Alert> : null}
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
  const contentMsg = (note?: string): ChatMsg => ({ from: "bot", text: contentBtn?.text ?? contentText, buttons: contentBtn ? [contentBtn.title] : undefined, note });
  const dm: ChatMsg[] = [];
  if (form.type === "story_reply") dm.push({ from: "user", text: `↩️ ردّ على قصتك\n${sampleText}` });
  if (form.type === "story_mention") dm.push({ from: "user", text: "📣 أشار إليك في قصته" });
  if (form.require_follow) {
    if (isComment) {
      const opening = strip(renderTemplate(form.opening_text || "حياك الله 🙌 رد بكلمة ابدأ", vars));
      dm.push({ from: "bot", text: opening, buttons: ["ابدأ"], note: "رد خاص على التعليق" });
      dm.push({ from: "user", text: "ابدأ" });
    }
    dm.push({ from: "bot", text: strip(renderTemplate(form.follow_request_text, vars)), buttons: ["تحقّق من المتابعة"] });
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
  const selected = media.find((m) => form.media_ids.includes(m.media_id));
  const preview = (
    <PhonePreview
      key={form.type}
      accountUsername={account?.username ?? "your_account"}
      avatarUrl={account?.profile_picture_url}
      postImage={isComment ? selected?.thumbnail_url : null}
      postCaption={isComment ? selected?.caption : form.type === "story_reply" ? "📱 قصتك" : "📣 قصة أشار فيها إليك أحدهم"}
      comments={comments}
      dm={dm}
      defaultTab="dm"
      footnote="معاينة مباشرة تتحدث أثناء التعديل — لا يُرسل شيء."
    />
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
      <aside className="order-last lg:order-first lg:sticky lg:top-4 lg:self-start">{preview}</aside>
      <div className="min-w-0 space-y-4">
      <PageHeader title={id ? "تعديل حملة" : "حملة جديدة"} subtitle={`الخطوة ${step + 1} من ${STEPS.length}: ${STEPS[step]}`} actions={<button className="btn btn-ghost" onClick={save} disabled={saving}>حفظ</button>} />
      <div className="flex gap-1" aria-hidden>
        {STEPS.map((_, i) => (
          <button key={i} onClick={() => setStep(i)} className={`h-2 flex-1 rounded-full ${i <= step ? "bg-brand-600" : "surface-2"}`} title={STEPS[i]} />
        ))}
      </div>
      {errors.length > 0 && (
        <Alert tone="bad">
          <ul className="list-inside list-disc">{errors.map((e, i) => <li key={i}>{e.message}{e.path ? ` (${e.path})` : ""}</li>)}</ul>
        </Alert>
      )}
      <Card title={STEPS[step]}>{stepBody()}</Card>
      <div className="flex justify-between gap-2">
        <button className="btn btn-ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>→ السابق</button>
        {step < STEPS.length - 1 && <button className="btn btn-primary" onClick={() => setStep((s) => s + 1)}>التالي ←</button>}
      </div>
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
