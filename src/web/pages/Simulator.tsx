import { useState } from "react";
import { api } from "../api";
import { Alert, Card, Field, PageHeader, toast, useAsync } from "../components/ui";
import { SimResult } from "./CampaignWizard";
import { PhonePreview, type ChatMsg, type CommentMsg } from "../components/PhonePreview";
import { REASONS } from "./Logs";

const SCENARIOS: Record<string, { label: string; script: any }> = {
  follower: { label: "متابع", script: { follow: ["following"] } },
  non_follower_then_follow: { label: "غير متابع ثم يتابع", script: { follow: ["not_following", "following"] } },
  never_follows: { label: "يضغط «تابعت» دون متابعة", script: { follow: ["not_following"] } },
  needs_interaction: { label: "يلزم تفاعل أولي", script: { follow: ["needs_interaction", "following"] } },
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
      let maxId = reset ? 0 : seen;
      for (const j of (r.jobs ?? []) as any[]) {
        if (j.id <= (reset ? 0 : seen)) continue;
        maxId = Math.max(maxId, j.id);
        if (j.kind === "send_message" && j.status === "accepted" && j.result?.text) {
          nextDm.push({ from: "bot", text: j.result.text, buttons: j.result.quick_replies?.map((q: any) => q.title), note: j.result.channel === "private_reply" ? "رد خاص على التعليق" : undefined });
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

  return (
    <div className="space-y-4">
      <PageHeader title="وضع التجربة (المحاكاة)" subtitle="منفصل تمامًا عن الإنتاج: حساب تجريبي وسجلات موسومة «تجريبي» ولا يُرسل أي شيء إلى إنستقرام." />
      <Alert tone="info">المحاكاة تمرّ عبر نفس محرك الإنتاج (الطابور، الحالات، منع التكرار) مع عميل Meta وهمي. لا ينتقل النظام لهذا الوضع تلقائيًا أبدًا.</Alert>
      <Card title="1) بدء سيناريو جديد">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="الحملة" hint="اختيار حملة يسمح بتجربة المسودات. بدون اختيار تُستخدم الحملات النشطة.">
            <select
              className="input"
              value={campaignId}
              onChange={async (e) => {
                const id = e.target.value ? Number(e.target.value) : "";
                setCampaignId(id);
                if (!id) return;
                // Pre-fill the text with the campaign's first trigger keyword and pick the matching event type.
                const c = await api(`/api/campaigns/${id}`).catch(() => null);
                if (!c) return;
                setEvent(c.type);
                const kw = (c.keywords as any[]).find((k) => k.kind === "include")?.keyword;
                if (kw) setText(c.type === "comment" ? `أبغى ${kw}` : kw);
              }}
            >
              <option value="">— الحملات النشطة —</option>
              {campaigns?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="نوع الحدث">
            <select className="input" value={event} onChange={(e) => setEvent(e.target.value)}>
              <option value="comment">تعليق</option>
              <option value="story_reply">رد على ستوري</option>
              <option value="story_mention">منشن في ستوري</option>
            </select>
          </Field>
          <Field label="النص"><input className="input" value={text} onChange={(e) => setText(e.target.value)} /></Field>
          <Field label="السيناريو">
            <select className="input" value={scenario} onChange={(e) => setScenario(e.target.value)}>
              {Object.entries(SCENARIOS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </Field>
        </div>
        {event === "comment" && (
          <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={isReply} onChange={(e) => setIsReply(e.target.checked)} /> تعليق متفرع (رد على تعليق آخر)</label>
        )}
        <button className="btn btn-primary mt-3 w-full" disabled={busy} onClick={() => run(event, true)}>تشغيل الحدث</button>
      </Card>
      <Card title="2) تفاعل الشخص التجريبي">
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ghost" disabled={busy} onClick={() => run("message", false, "ابدأ")}>يرد «ابدأ»</button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => run("verify_button", false)}>يضغط «تحقّق من المتابعة»</button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => run("message", false, "تابعت")}>يكتب «تابعت»</button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => run("message", false, "شكرًا")}>رسالة عادية</button>
        </div>
        <p className="muted mt-2 text-xs">الفاصل الزمني بين محاولات التحقق مطبّق هنا كما في الإنتاج — انتظر المدة المحددة في الحملة.</p>
      </Card>
      {result && (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <PhonePreview
            key={seen === 0 ? "reset" : "live"}
            accountUsername={account?.username ?? "hsn_demo"}
            avatarUrl={account?.profile_picture_url}
            comments={comments}
            dm={dm}
            defaultTab="dm"
            footnote="محاكاة — لا يُرسل أي شيء إلى إنستقرام."
          />
          <Card title="التفاصيل التقنية"><SimResult sim={result} /></Card>
        </div>
      )}
    </div>
  );
}
