import { useEffect, useState } from "react";
import { api } from "../api";
import { AR_LABELS } from "../../shared/states";
import { Card, Field, toast, useAsync } from "../components/ui";
import { Icon } from "../components/Icon";
import { SimResult } from "./CampaignWizard";
import { PhonePreview, type ButtonAction, type ChatMsg, type CommentMsg } from "../components/PhonePreview";
import { openExternal } from "../platform";
import { REASONS } from "./Logs";
import { MenuSimulator } from "../components/DmMenuEditor";

/** The common cases shown first; the rest are under «سيناريوهات أخرى». */
const MAIN_SCENARIOS = ["non_follower_then_follow", "known_follower", "verify_fails", "follower"];

type TimelineItem = { title: string; sub?: string; color: string };
const DOT: Record<string, string> = { blue: "#3b82f6", orange: "#f59e0b", green: "#10b981", red: "#ef4444", violet: "#a855f7", gray: "#94a3b8" };

function eventTitle(ev: string, status: string) {
  if (status === "ignored") return "تم تجاهل الحدث";
  return { comment: "تعليق مطابق", story_reply: "رد على ستوري", story_mention: "منشن في ستوري", verify_button: "ضغط «تحقّق من المتابعة»", start_button: "ضغط «ابدأ»", message: "رسالة من الشخص" }[ev] ?? ev;
}

function jobItem(j: any): TimelineItem | null {
  if (j.kind === "process_event") return null;
  const purpose = j.purpose ? ` · ${j.purpose}` : "";
  if (j.kind === "follow_check") {
    const f = j.result?.follow;
    if (f === "following") return { title: "تحقق: متابع ✓", sub: `verify · following`, color: "green" };
    if (f === "not_following") return { title: "تحقق: غير متابع", sub: `verify · not_following`, color: "red" };
    if (f === "needs_interaction") return { title: "فحص أولي: لا موافقة بعد", sub: "يُرسل «ابدأ» · needs_interaction", color: "orange" };
    return { title: `تحقق: ${AR_LABELS[f] ?? f ?? AR_LABELS[j.status] ?? j.status}`, sub: j.last_error ?? undefined, color: "orange" };
  }
  if (j.kind === "public_reply") return { title: j.status === "accepted" ? "رد عام على التعليق" : `رد عام: ${AR_LABELS[j.status] ?? j.status}`, sub: j.result?.text, color: j.status === "accepted" ? "blue" : "red" };
  if (j.kind === "send_message") {
    const ch = j.result?.channel === "private_reply" ? "رد خاص" : "رسالة خاصة";
    if (j.status !== "accepted") return { title: `${ch}: ${AR_LABELS[j.status] ?? j.status}`, sub: j.last_error ?? undefined, color: j.status === "pending" ? "gray" : "red" };
    if (j.result?.link_button) return { title: `أُرسل المحتوى · زر «${j.result.link_button.title}»`, sub: `content${purpose}`, color: "violet" };
    return { title: `${ch} · قبلته Meta`, sub: `${String(j.result?.text ?? "").slice(0, 40)}${purpose}`, color: "green" };
  }
  return { title: j.kind, sub: AR_LABELS[j.status] ?? j.status, color: "gray" };
}

const SCENARIOS: Record<string, { label: string; script: any }> = {
  non_follower_then_follow: { label: "أول مرة يتواصل · غير متابع ثم يتابع", script: { follow: ["not_following", "following"] } },
  follower: { label: "أول مرة يتواصل · متابع", script: { follow: ["following"] } },
  known_follower: { label: "سبق وراسلك · متابع (يوصله المحتوى مباشرة)", script: { follow: ["following"], known: true } },
  known_non_follower: { label: "سبق وراسلك · غير متابع ثم يتابع", script: { follow: ["not_following", "following"], known: true } },
  never_follows: { label: "يضغط «تابعت» دون متابعة", script: { follow: ["not_following"] } },
  verify_fails: { label: "فشل التحقق (خطأ API)", script: { follow: ["temporary_error"] } },
  verify_delayed: { label: "تأخر تحديث الحالة (غير معروف ثم متابع)", script: { follow: ["unknown", "following"] } },
  unsupported: { label: "الميزة غير متاحة", script: { follow: ["unsupported"] } },
  window_closed: { label: "انتهاء نافذة المراسلة", script: { follow: ["not_following", "following"], dm: "window_closed" } },
  private_fail: { label: "فشل الرد الخاص", script: { privateReply: "fail" } },
  public_fail: { label: "فشل الرد العام", script: { publicReply: "fail" } },
  uncertain: { label: "انقطاع بعد الإرسال (غير مؤكد)", script: { privateReply: "uncertain", dm: "uncertain" } },
};

export function SimulatorPage() {
  const { data: campaigns } = useAsync(() => api<any[]>("/api/campaigns"), []);
  const [simTab, setSimTab] = useState<"campaigns" | "menu">(() => (location.hash.includes("tab=menu") ? "menu" : "campaigns"));
  const [campaignId, setCampaignId] = useState<number | "">("");
  const [event, setEvent] = useState("comment");
  const [text, setText] = useState("أبغى الكورس");
  const [scenario, setScenario] = useState("non_follower_then_follow");
  const [isReply, setIsReply] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [dm, setDm] = useState<ChatMsg[]>([]);
  const [comments, setComments] = useState<CommentMsg[]>([]);
  const [seen, setSeen] = useState<number>(0);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const pickCampaign = async (id: number | "") => {
    setCampaignId(id);
    if (!id) return;
    // Pre-fill the text with the campaign's first trigger keyword and pick the matching event type.
    const c = await api(`/api/campaigns/${id}`).catch(() => null);
    if (!c) return;
    setEvent(c.type);
    const kw = (c.keywords as any[]).find((k) => k.kind === "include")?.keyword;
    if (kw) setText(c.type === "comment" ? `أبغى ${kw}` : kw);
  };
  // Opened from the campaign wizard: #/simulator?campaign=ID
  useEffect(() => {
    const id = Number(new URLSearchParams(location.hash.split("?")[1] ?? "").get("campaign"));
    if (id) void pickCampaign(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { data: account } = useAsync(() => api("/api/account").then((r) => r.account).catch(() => null), []);

  const run = async (ev: string, reset: boolean, txt = text) => {
    setBusy(true);
    try {
      const r = await api("/api/simulate", {
        body: { campaign_id: campaignId || undefined, event: ev, text: txt, participant: "sim_user", reset, is_reply: isReply, script: reset ? SCENARIOS[scenario].script : undefined },
      });
      setResult(r);
      // Build the phone transcript: the user's action, then every new bot action from the demo pipeline.
      const nextDm = reset ? [] : [...dm];
      const nextComments = reset ? [] : [...comments];
      if (ev === "comment") nextComments.push({ username: "sim_user", text: txt });
      else if (ev === "story_reply") nextDm.push({ from: "user", text: `↩️ ردّ على قصتك\n${txt}` });
      else if (ev === "story_mention") nextDm.push({ from: "user", text: "📣 أشار إليك في قصته" });
      else if (ev === "verify_button") nextDm.push({ from: "user", text: "تحقّق من المتابعة" });
      else if (ev === "start_button") nextDm.push({ from: "user", text: "ابدأ" });
      else nextDm.push({ from: "user", text: txt });
      if (r.event?.status === "ignored") {
        const why = REASONS[String(r.event.reason ?? "").split(" ")[0]] ?? r.event.reason;
        nextDm.push({ from: "bot", text: `ℹ️ تجاهل النظام هذا الحدث: ${why}`, note: "ملاحظة المحاكاة (لا تظهر للشخص)" });
      }
      const tl = reset ? [] : [...timeline];
      tl.push({
        title: eventTitle(ev, r.event?.status),
        sub: [ev === "comment" || ev === "message" || ev === "story_reply" ? `«${txt}»` : "", REASONS[String(r.event?.reason ?? "").split(" ")[0]] ?? r.event?.reason].filter(Boolean).join(" · "),
        color: r.event?.status === "ignored" ? "gray" : "blue",
      });
      for (const j of (r.jobs ?? []) as any[]) {
        if (j.id <= (reset ? 0 : seen)) continue;
        const it = jobItem(j);
        if (it) tl.push(it);
      }
      setTimeline(tl);
      let maxId = reset ? 0 : seen;
      for (const j of (r.jobs ?? []) as any[]) {
        if (j.id <= (reset ? 0 : seen)) continue;
        maxId = Math.max(maxId, j.id);
        if (j.kind === "send_message" && j.status === "accepted" && j.result?.text) {
          const lb = j.result.link_button;
          const ab = j.result.account_button;
          // What each button does when tapped in the phone (start / verify run the real pipeline; links open).
          const realAccountUrl = account?.username ? `https://www.instagram.com/${account.username}/` : ab?.url;
          const actions: ButtonAction[] = lb
            ? [{ type: "url", url: lb.url }]
            : [
                ...(ab ? [{ type: "url", url: realAccountUrl } as ButtonAction] : []),
                ...((j.result.quick_replies ?? []) as any[]).map((q): ButtonAction => (String(q.payload).includes(":verify:") ? { type: "verify" } : { type: "start" })),
              ];
          nextDm.push({
            buttonActions: actions,
            from: "bot",
            text: lb?.text ?? (j.result.account_button ? String(j.result.text).split(j.result.account_button.url).join("").replace(/[ \t]{2,}/g, " ").trim() : j.result.text),
            buttons: lb ? [lb.title] : [...(j.result.account_button ? [j.result.account_button.title] : []), ...(j.result.quick_replies?.map((q: any) => q.title) ?? [])],
            note: j.result.channel === "private_reply" ? "رد خاص على التعليق" : undefined,
          });
        } else if (j.kind === "send_message" && j.status !== "accepted" && j.status !== "pending") {
          nextDm.push({ from: "bot", text: `⚠️ لم تُرسل (${j.status})${j.last_error ? `: ${j.last_error}` : ""}` });
        } else if (j.kind === "public_reply" && j.status === "accepted" && j.result?.text) {
          nextComments.push({ username: account?.username ?? "hsn_demo", isOwner: true, text: j.result.text });
        }
      }
      setDm(nextDm);
      setComments(nextComments);
      setSeen(maxId);
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };

  const flowState = result?.flows?.[0]?.state as string | undefined;
  const scenarioRadio = (k: string) => (
    <label key={k} className={`flex cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 text-sm font-semibold transition ${scenario === k ? "border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-200" : "border-[var(--border)] hover:bg-[var(--surface-2)]"}`}>
      <input type="radio" name="scenario" className="accent-violet-600" checked={scenario === k} onChange={() => setScenario(k)} />
      {SCENARIOS[k].label}
    </label>
  );

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold leading-tight sm:text-[26px]">المحاكاة</h1>
          <p className="muted mt-1 text-sm">جرّب أي حملة بنفس محرك الإنتاج — لا يُرسل أي شيء إلى إنستقرام.</p>
        </div>
        <span className="chip bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"><span className="h-1.5 w-1.5 rounded-full bg-current" />وضع تجريبي</span>
      </header>
      <div className="surface-2 inline-flex rounded-full p-1 text-sm" role="tablist">
        {([["campaigns", "الحملات"], ["menu", "القائمة التلقائية"]] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={simTab === k} onClick={() => setSimTab(k)} className={`rounded-full px-4 py-1.5 font-semibold ${simTab === k ? "bg-[var(--surface)] shadow" : "muted"}`}>{l}</button>
        ))}
      </div>
      {simTab === "menu" ? (
        <Card title="💬 تجربة القائمة التلقائية"><MenuSimulator /></Card>
      ) : (<>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_330px_minmax(0,0.9fr)]">
        <Card title="السيناريو">
          <div className="space-y-4">
            <Field label="الحملة" hint="اختيار حملة يسمح بتجربة المسودات. بدون اختيار تُستخدم الحملات النشطة.">
              <select className="input" value={campaignId} onChange={(e) => pickCampaign(e.target.value ? Number(e.target.value) : "")}>
                <option value="">— الحملات النشطة —</option>
                {campaigns?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <div>
              <div className="font-display mb-1.5 text-[13px] font-bold text-[var(--text-2)]">نوع الحدث</div>
              <div className="flex flex-wrap gap-2">
                {([["comment", "💬 تعليق"], ["story_reply", "↩️ رد ستوري"], ["story_mention", "📣 منشن"]] as const).map(([k, l]) => (
                  <button key={k} type="button" onClick={() => setEvent(k)} className={`rounded-2xl border px-4 py-2.5 text-sm font-bold transition ${event === k ? "border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-200" : "border-[var(--border)] hover:bg-[var(--surface-2)]"}`}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            {event !== "story_mention" && (
              <Field label={event === "comment" ? "نص التعليق" : "نص الرد"}><input className="input" value={text} onChange={(e) => setText(e.target.value)} /></Field>
            )}
            {event === "comment" && (
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-violet-600" checked={isReply} onChange={(e) => setIsReply(e.target.checked)} /> تعليق متفرع (رد على تعليق آخر)</label>
            )}
            <div>
              <div className="font-display mb-1.5 text-[13px] font-bold text-[var(--text-2)]">حالة الشخص</div>
              <div className="space-y-2">
                {MAIN_SCENARIOS.map(scenarioRadio)}
                <details className="group" open={!MAIN_SCENARIOS.includes(scenario)}>
                  <summary className="muted cursor-pointer select-none py-1 text-sm font-semibold">سيناريوهات أخرى ({Object.keys(SCENARIOS).length - MAIN_SCENARIOS.length})</summary>
                  <div className="mt-2 space-y-2">{Object.keys(SCENARIOS).filter((k) => !MAIN_SCENARIOS.includes(k)).map(scenarioRadio)}</div>
                </details>
              </div>
            </div>
            <button className="btn btn-primary w-full !min-h-[52px] text-base" disabled={busy} onClick={() => run(event, true)}>
              <Icon name="play" size={20} />{busy ? "جارٍ التشغيل…" : "تشغيل"}
            </button>
          </div>
        </Card>

        <div className="lg:sticky lg:top-20 lg:self-start">
          <PhonePreview
            key={seen === 0 ? "reset" : "live"}
            accountUsername={account?.username ?? "hsn_demo"}
            avatarUrl={account?.profile_picture_url}
            comments={comments}
            dm={dm}
            defaultTab="dm"
            busy={busy || !result}
            inputPlaceholder={result ? "اكتب رسالة كأنك الشخص…" : "شغّل السيناريو أولًا"}
            onSend={(t) => run("message", false, t)}
            onButton={(a) => {
              if (a.type === "start") run("start_button", false);
              else if (a.type === "verify") run("verify_button", false);
              else void openExternal(a.url);
            }}
            footnote="👆 اضغط الأزرار داخل الرسائل للتفاعل"
          />
        </div>

        <Card title="الخط الزمني" action={flowState ? <span className="chip bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-current" />{AR_LABELS[flowState] ?? flowState}</span> : undefined} className="lg:col-span-2 xl:col-span-1">
          {!timeline.length ? (
            <ol className="muted list-decimal space-y-1.5 pr-5 text-sm">
              <li>اختر الحملة وحالة الشخص واضغط «تشغيل».</li>
              <li>تظهر الرسائل في الجوال كما يشوفها الشخص.</li>
              <li>اضغط «ابدأ» أو «تحقّق من المتابعة» داخل الرسالة، أو اكتب أي رد.</li>
              <li>كل خطوة يسويها النظام تظهر هنا بالترتيب.</li>
            </ol>
          ) : (
            <ol className="relative space-y-5 pr-6">
              <span className="absolute bottom-2 right-[7px] top-2 w-0.5 rounded bg-[var(--border)]" aria-hidden />
              {timeline.map((t, i) => (
                <li key={i} className="relative">
                  <span className="absolute -right-6 top-1 h-4 w-4 rounded-full border-[3px] border-[var(--surface)]" style={{ background: DOT[t.color] ?? DOT.gray }} aria-hidden />
                  <div className="font-display text-[15px] font-bold">{t.title}</div>
                  {t.sub && <div className="muted mt-0.5 line-clamp-2 text-[13px]">{t.sub}</div>}
                </li>
              ))}
            </ol>
          )}
          {result && (
            <details className="mt-5 border-t border-[var(--border)] pt-3">
              <summary className="muted cursor-pointer text-sm font-semibold">التفاصيل التقنية</summary>
              <SimResult sim={result} />
            </details>
          )}
        </Card>
      </div>
      <p className="muted text-center text-xs">المحاكاة تمرّ عبر نفس محرك الإنتاج (الطابور، الحالات، منع التكرار) مع عميل Meta وهمي. «افتح حسابنا» يفتح حسابك الحقيقي. لا ينتقل النظام لهذا الوضع تلقائيًا أبدًا.</p>
      </>)}
    </div>
  );
}
