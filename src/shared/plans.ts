/** What a subscription plan allows. `null` = unlimited. Edited by the owner (no code change needed). */
export interface PlanLimits {
  active_campaigns: number | null;
  monthly_messages: number | null;
  events: Array<"comment" | "story_reply" | "story_mention">;
  public_reply: boolean;
  link_tracking: boolean;
  inbox_manual: boolean;
  telegram: boolean;
  recover: boolean;
  csv_export: boolean;
  /** Draws created per month: 0 = none, null = unlimited. */
  draws_per_month: number | null;
  draw_video: boolean;
  cards: boolean;
}

/** The owner's own workspace: everything, no expiry. */
export const OWNER_LIMITS: PlanLimits = {
  active_campaigns: null,
  monthly_messages: null,
  events: ["comment", "story_reply", "story_mention"],
  public_reply: true,
  link_tracking: true,
  inbox_manual: true,
  telegram: true,
  recover: true,
  csv_export: true,
  draws_per_month: null,
  draw_video: true,
  cards: true,
};

export const FEATURE_LABELS: Record<string, string> = {
  public_reply: "الرد العام على التعليق",
  link_tracking: "تتبع الضغط على الرابط",
  inbox_manual: "الرد اليدوي من صندوق الرسائل",
  telegram: "إشعارات تيليجرام والتقرير اليومي",
  recover: "استرجاع التعليقات الفائتة",
  csv_export: "تصدير السجلات CSV",
  draw_video: "تسجيل فيديو السحب",
  cards: "بطاقات تهنئة الفائزين بشعارك",
};

export const EVENT_LABELS: Record<string, string> = { comment: "تعليقات", story_reply: "ردود الستوري", story_mention: "منشن الستوري" };

/** Activation code format: HSN-XXXX-XXXX-XXXX (no ambiguous characters). */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^HSN/, "");
}
