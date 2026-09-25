import { z } from "zod";

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => z.string().trim().max(max).nullable().optional();

export const keywordSchema = z.object({
  keyword: text(100).min(1),
  kind: z.enum(["include", "exclude"]),
  match_type: z.enum(["exact", "word", "contains"]),
});

export const campaignInputSchema = z
  .object({
    name: text(120).min(1),
    type: z.enum(["comment", "story_reply", "story_mention"]),
    priority: z.number().int().min(0).max(1000).default(100),
    scope: z.enum(["all", "selected"]).default("all"),
    media_ids: z.array(z.string().regex(/^[0-9A-Za-z_]{1,64}$/)).max(200).default([]),
    match_all: z.boolean().default(false),
    unify_alef: z.boolean().default(true),
    include_replies: z.boolean().default(false),
    keywords: z.array(keywordSchema).max(100).default([]),
    require_follow: z.boolean().default(false),
    opening_text: optText(900),
    follow_request_text: optText(900),
    follow_reminder_text: optText(900),
    verify_error_text: optText(900),
    final_text: text(900).default(""),
    final_url: z
      .string()
      .trim()
      .max(1000)
      .refine((v) => v === "" || /^https:\/\/[^\s]+$/i.test(v), "يجب أن يبدأ الرابط بـ https://")
      .nullable()
      .optional(),
    public_reply_enabled: z.boolean().default(false),
    public_reply_text: optText(300),
    public_reply_on_dm_fail: z.enum(["none", "fallback"]).default("none"),
    public_reply_fallback_text: optText(300),
    schedule_start: z.number().int().nullable().optional(),
    schedule_end: z.number().int().nullable().optional(),
    timezone: text(64).default("Asia/Aden"),
    per_user_cooldown_hours: z.number().int().min(0).max(24 * 365).default(24),
    max_deliveries_per_user: z.number().int().min(0).max(100).default(1),
    max_verify_attempts: z.number().int().min(1).max(50).default(5),
    verify_cooldown_seconds: z.number().int().min(5).max(86_400).default(30),
    process_old_events: z.boolean().default(false),
  })
  .superRefine((c, ctx) => {
    if (!c.match_all && !c.keywords.some((k) => k.kind === "include") && c.type !== "story_mention") {
      ctx.addIssue({ code: "custom", path: ["keywords"], message: "أضف كلمة تشغيل واحدة على الأقل أو فعّل «جميع التعليقات/الردود»" });
    }
    if (c.scope === "selected" && c.media_ids.length === 0) {
      ctx.addIssue({ code: "custom", path: ["media_ids"], message: "اختر منشورًا أو ستوري واحدة على الأقل" });
    }
    if (!c.final_text.trim() && !c.final_url) {
      ctx.addIssue({ code: "custom", path: ["final_text"], message: "حدد المحتوى النهائي (نص أو رابط)" });
    }
    if (c.type !== "comment" && c.public_reply_enabled) {
      ctx.addIssue({ code: "custom", path: ["public_reply_enabled"], message: "الرد العام متاح لحملات التعليقات فقط" });
    }
    if (c.schedule_start && c.schedule_end && c.schedule_end <= c.schedule_start) {
      ctx.addIssue({ code: "custom", path: ["schedule_end"], message: "نهاية الجدول يجب أن تكون بعد البداية" });
    }
    if (c.final_url) {
      for (const f of ["opening_text", "follow_request_text", "follow_reminder_text", "verify_error_text", "public_reply_text", "public_reply_fallback_text"] as const) {
        if (c[f] && c[f]!.includes(c.final_url)) {
          ctx.addIssue({ code: "custom", path: [f], message: "لا تضع رابط المحتوى النهائي في هذه الرسالة" });
        }
      }
    }
  });
export type CampaignInput = z.infer<typeof campaignInputSchema>;

export const templateInputSchema = z.object({
  kind: z.enum(["public", "opening", "follow_request", "reminder", "final", "error", "mention"]),
  name: text(80).min(1),
  body: text(900).min(1),
});

export const loginSchema = z.object({
  username: text(64).min(1),
  password: z.string().min(1).max(256),
  client: z.enum(["web", "app"]).default("web"),
  device_label: optText(80),
});

export const setupSchema = z.object({
  setup_token: z.string().min(16).max(256),
  username: text(64).regex(/^[A-Za-z0-9_.-]{3,64}$/, "اسم المستخدم: أحرف إنجليزية وأرقام فقط"),
  password: z.string().min(12, "كلمة المرور 12 حرفًا على الأقل").max(256),
});

export const settingsSchema = z.object({
  timezone: text(64).optional(),
  retention_days: z.number().int().min(7).max(3650).optional(),
  dedup_retention_days: z.number().int().min(8).max(3650).optional(),
  any_reply_counts_as_start: z.boolean().optional(),
  global_user_hourly_limit: z.number().int().min(0).max(1000).optional(),
});

export const simulateSchema = z.object({
  campaign_id: z.number().int().positive().optional(),
  event: z.enum(["comment", "story_reply", "story_mention", "message", "verify_button", "start_button"]),
  text: text(500).default(""),
  participant: text(40).regex(/^[A-Za-z0-9_.-]+$/).default("demo_user"),
  is_reply: z.boolean().default(false),
  media_id: z.string().max(64).optional(),
  script: z
    .object({
      follow: z.array(z.enum(["following", "not_following", "unknown", "needs_interaction", "temporary_error", "unsupported"])).max(10).optional(),
      privateReply: z.enum(["ok", "fail", "uncertain"]).optional(),
      dm: z.enum(["ok", "window_closed", "fail", "uncertain"]).optional(),
      publicReply: z.enum(["ok", "fail"]).optional(),
    })
    .optional(),
  reset: z.boolean().default(false),
});
