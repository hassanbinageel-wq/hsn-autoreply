/** Support center labels shared by the server and the app. */
export const CATEGORIES = { tech: "مشكلة تقنية", question: "استفسار", billing: "اشتراك ودفع", suggestion: "اقتراح" } as const;
export const STATES = { new: "جديد", in_progress: "قيد المعالجة", waiting: "بانتظار ردك", resolved: "تم الحل" } as const;
export const PRIORITIES = { low: "منخفضة", normal: "عادية", high: "عالية", urgent: "عاجلة" } as const;
export type TicketCategory = keyof typeof CATEGORIES;
export type TicketState = keyof typeof STATES;
export type TicketPriority = keyof typeof PRIORITIES;
/** Ticket number shown to people (so the first ticket is not «#1»). */
export const ticketNo = (id: number) => 1000 + id;
/** Attachment limits: an image up to 5 MB or a video up to 25 MB. */
export const ATTACH_IMAGE = ["image/jpeg", "image/png", "image/webp"];
export const ATTACH_VIDEO = ["video/mp4", "video/quicktime"];
export const ATTACH_IMAGE_BYTES = 5 * 1024 * 1024;
export const ATTACH_VIDEO_BYTES = 25 * 1024 * 1024;
