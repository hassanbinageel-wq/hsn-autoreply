/** Conversation flow states (per participant + campaign). */
export const FLOW_STATES = [
  "trigger_received",
  "awaiting_user_interaction",
  "checking_follow",
  "awaiting_follow",
  "ready_to_deliver",
  "delivering",
  "content_sent",
  "verification_unavailable",
  "expired",
  "failed",
  "cancelled",
] as const;
export type FlowState = (typeof FLOW_STATES)[number];

export const TERMINAL_FLOW_STATES: readonly FlowState[] = [
  "content_sent",
  "verification_unavailable",
  "expired",
  "failed",
  "cancelled",
];

/** Allowed transitions. Anything else is rejected by the engine. */
export const FLOW_TRANSITIONS: Record<FlowState, readonly FlowState[]> = {
  trigger_received: ["awaiting_user_interaction", "checking_follow", "delivering", "expired", "failed", "cancelled"],
  awaiting_user_interaction: ["checking_follow", "expired", "failed", "cancelled"],
  checking_follow: [
    "awaiting_follow",
    "awaiting_user_interaction",
    "ready_to_deliver",
    "verification_unavailable",
    "expired",
    "failed",
    "cancelled",
  ],
  awaiting_follow: ["checking_follow", "expired", "failed", "cancelled"],
  ready_to_deliver: ["delivering", "checking_follow", "expired", "failed", "cancelled"],
  delivering: ["content_sent", "ready_to_deliver", "awaiting_follow", "expired", "failed", "cancelled"],
  content_sent: [],
  verification_unavailable: [],
  expired: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: FlowState, to: FlowState): boolean {
  return FLOW_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Independent status for every action (private reply, public reply, DM, follow check...). */
export const ACTION_STATUSES = [
  "pending",
  "processing",
  "accepted",
  "retry_scheduled",
  "uncertain",
  "failed",
  "cancelled",
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const FOLLOW_RESULTS = [
  "following",
  "not_following",
  "unknown",
  "needs_interaction",
  "temporary_error",
  "unsupported",
] as const;

export const AR_LABELS: Record<string, string> = {
  trigger_received: "تم استلام الحدث",
  awaiting_user_interaction: "بانتظار تفاعل المستخدم",
  checking_follow: "جارٍ التحقق من المتابعة",
  awaiting_follow: "بانتظار المتابعة",
  ready_to_deliver: "جاهز للتسليم",
  delivering: "جارٍ الإرسال",
  content_sent: "أُرسل المحتوى (قبلته Meta)",
  verification_unavailable: "التحقق غير متاح",
  expired: "منتهي",
  failed: "فشل",
  cancelled: "ملغى",
  pending: "معلّق",
  processing: "قيد التنفيذ",
  accepted: "قبلته Meta",
  retry_scheduled: "إعادة مجدولة",
  uncertain: "نتيجة غير مؤكدة",
  following: "متابع",
  not_following: "غير متابع",
  unknown: "الحالة غير معروفة",
  needs_interaction: "يلزم تفاعل المستخدم أولًا",
  temporary_error: "تعذر التحقق مؤقتًا",
  unsupported: "الميزة غير متاحة لهذا الربط",
  comment: "تعليق",
  story_reply: "رد على ستوري",
  story_mention: "منشن في ستوري",
  message: "رسالة خاصة",
  quick_reply: "زر رد سريع",
  postback: "زر",
  echo: "صدى رسالة",
  reaction: "تفاعل",
  other: "حدث آخر",
  processed: "تمت المعالجة",
  ignored: "تم التجاهل",
};
