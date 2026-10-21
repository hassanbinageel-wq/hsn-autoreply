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

export interface ParsedFaq {
  sections: Array<{ title: string; items: Array<{ question: string; answer: string; video_url?: string }> }>;
  /** Lines that were not part of any question (shown in the preview). */
  ignored: string[];
}

const clean = (l: string) => l.replace(/\*\*/g, "").replace(/^#+\s*/, "").replace(/^[•\-–]\s+(?=[سج]\s*[:：])/, "").trim();
const Q = /^س\s*[:：]\s*/;
const A = /^ج\s*[:：]\s*/;
const VIDEO = /^(?:فيديو|الفيديو|رابط الفيديو)\s*[:：]\s*(https:\/\/\S+)/;
const BREAK = /^(?:-{3,}|—{2,}|_{3,}|\*{3,})$/;

/**
 * FAQ pasted as text: a section title on its own line, then «س: …» and «ج: …» for each question (answers may span
 * several lines; «فيديو: https://…» adds a video link). «---» ends the current answer. A title is a line that comes
 * after an empty line / «---» / the start and is followed by a question.
 */
export function parseFaqText(text: string): ParsedFaq {
  const lines = text.replace(/\r/g, "").split("\n").map(clean);
  const out: ParsedFaq = { sections: [], ignored: [] };
  let section: ParsedFaq["sections"][number] | null = null;
  let item: { question: string; answer: string; video_url?: string } | null = null;
  let field: "q" | "a" | null = null;
  const nextNonEmpty = (i: number) => {
    for (let j = i + 1; j < lines.length; j++) if (lines[j]) return lines[j];
    return "";
  };
  const close = () => {
    if (item && item.question && item.answer) {
      if (!section) out.sections.push((section = { title: "عام", items: [] }));
      section.items.push({ question: item.question.slice(0, 200), answer: item.answer.slice(0, 3000), ...(item.video_url ? { video_url: item.video_url } : {}) });
    } else if (item) out.ignored.push(item.question || item.answer);
    item = null;
    field = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const prevBlank = i === 0 || !lines[i - 1] || BREAK.test(lines[i - 1]);
    if (!l) continue;
    if (BREAK.test(l)) {
      close();
      continue;
    }
    if (Q.test(l)) {
      close();
      item = { question: l.replace(Q, ""), answer: "" };
      field = "q";
      continue;
    }
    if (A.test(l) && item) {
      item.answer = l.replace(A, "");
      field = "a";
      continue;
    }
    const v = VIDEO.exec(l);
    if (v && item) {
      item.video_url = v[1];
      continue;
    }
    if (prevBlank && Q.test(nextNonEmpty(i)) && l.length <= 80) {
      close();
      out.sections.push((section = { title: l.replace(/[:：]$/, "").slice(0, 80), items: [] }));
      continue;
    }
    if (item && field === "a") item.answer += `\n${l}`;
    else if (item && field === "q") item.question += ` ${l}`;
    else out.ignored.push(l);
  }
  close();
  out.sections = out.sections.filter((s) => s.items.length);
  return out;
}
