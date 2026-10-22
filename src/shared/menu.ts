/**
 * «القائمة التلقائية» in direct messages: a message with options; tapping an option sends its own reply, which can
 * open a sub-menu. Built by each customer for their own account.
 *
 * Limits follow what the app already sends to Instagram: a button template holds at most 3 buttons (a link button
 * takes one of them) with text up to 640 characters; quick replies (chips under the message) up to 13; button and
 * chip titles are cut at 20 characters.
 */
export interface MenuNode {
  /** Stable id used in the button payload (hsn:menu:<key>). */
  key: string;
  /** Button / chip title (unused on the root). */
  label: string;
  /** The message sent when this option is tapped (for the root: the menu message). */
  text: string;
  link?: { title: string; url: string } | null;
  /** How this node's options are shown: buttons under the message (≤ 3) or quick-reply chips (≤ 13). */
  style: "buttons" | "quick";
  children: MenuNode[];
}

export interface DmMenu {
  enabled: boolean;
  /** When the menu is sent to someone who writes: their first message only, at most once a day, or every message. */
  trigger: "first" | "daily" | "every";
  /** After the account replies by hand to a person, the menu stays quiet for them this many hours (0 = never pause). */
  pause_hours: number;
  root: MenuNode;
  /**
   * Ice breakers: up to 4 questions shown before someone's first message (Instagram app only); each sends the reply
   * of a menu option.
   */
  ice_breakers?: Array<{ question: string; key: string }>;
  /** Persistent menu: always available inside the conversation; an item opens a menu option or a link. */
  persistent?: Array<{ title: string; key?: string; url?: string }>;
}

export const MENU_LIMITS = { depth: 3, buttons: 3, quick: 13, label: 20, text: 640, iceBreakers: 4, question: 80, persistent: 5, persistentTitle: 30 } as const;
export const MENU_PAYLOAD = /^hsn:menu:([A-Za-z0-9]{4,16})$/;
export const menuPayload = (key: string) => `hsn:menu:${key}`;

export const TRIGGER_LABELS: Record<DmMenu["trigger"], string> = {
  first: "أول رسالة من الشخص فقط",
  daily: "مرة كل 24 ساعة كحد أقصى",
  every: "مع كل رسالة",
};

export function newKey(): string {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => a[b % a.length]).join("");
}

export const emptyMenu = (): DmMenu => ({
  enabled: false,
  trigger: "daily",
  pause_hours: 12,
  root: { key: newKey(), label: "", text: "أهلًا 👋 كيف نقدر نساعدك؟ اختر من القائمة:", link: null, style: "buttons", children: [] },
});

/** Most options a node may have with its display style (a link button uses one of the 3 template slots). */
export const maxOptions = (n: Pick<MenuNode, "style" | "link">) => (n.style === "quick" ? MENU_LIMITS.quick : MENU_LIMITS.buttons - (n.link ? 1 : 0));

/** Finds a node by key anywhere in the tree. */
export function findNode(root: MenuNode, key: string): MenuNode | null {
  if (root.key === key) return root;
  for (const c of root.children) {
    const f = findNode(c, key);
    if (f) return f;
  }
  return null;
}

/** First problem in a menu tree, in plain Arabic (null = fine). */
export function menuProblem(root: MenuNode): string | null {
  const keys = new Set<string>();
  const walk = (n: MenuNode, depth: number, path: string): string | null => {
    if (keys.has(n.key)) return "مفتاح مكرر في القائمة";
    keys.add(n.key);
    if (!n.text.trim()) return `${path}: اكتب نص الرسالة`;
    if (n.text.length > MENU_LIMITS.text) return `${path}: النص أطول من ${MENU_LIMITS.text} حرف`;
    if (depth > 0 && !n.label.trim()) return `${path}: اكتب عنوان الزر`;
    if (n.label.length > MENU_LIMITS.label) return `${path}: عنوان الزر أطول من ${MENU_LIMITS.label} حرف`;
    if (n.link && (!/^https:\/\//.test(n.link.url) || !n.link.title.trim() || n.link.title.length > MENU_LIMITS.label)) return `${path}: زر الرابط يحتاج عنوان (حتى ${MENU_LIMITS.label} حرف) ورابط يبدأ بـ https://`;
    if (n.children.length > maxOptions(n)) return `${path}: الحد ${maxOptions(n)} خيارات بهذا الشكل${n.style === "buttons" ? " — غيّر الشكل إلى «أزرار سريعة» لخيارات أكثر" : ""}`;
    if (n.children.length && depth + 1 >= MENU_LIMITS.depth + 1) return `${path}: الحد ${MENU_LIMITS.depth} مستويات`;
    for (const c of n.children) {
      const e = walk(c, depth + 1, `«${c.label || "خيار"}»`);
      if (e) return e;
    }
    return null;
  };
  return walk(root, 0, "رسالة القائمة");
}

/** Problems in the ice breakers / persistent menu (keys must point to existing options). */
export function extrasProblem(m: Pick<DmMenu, "root" | "ice_breakers" | "persistent">): string | null {
  for (const q of m.ice_breakers ?? []) {
    if (!q.question.trim()) return "أسئلة البداية: اكتب نص السؤال";
    if (q.question.length > MENU_LIMITS.question) return `أسئلة البداية: السؤال أطول من ${MENU_LIMITS.question} حرف`;
    if (!findNode(m.root, q.key)) return `أسئلة البداية: «${q.question}» مربوط بخيار محذوف`;
  }
  if ((m.ice_breakers ?? []).length > MENU_LIMITS.iceBreakers) return `أسئلة البداية: الحد ${MENU_LIMITS.iceBreakers}`;
  for (const p of m.persistent ?? []) {
    if (!p.title.trim()) return "القائمة الثابتة: اكتب عنوان العنصر";
    if (p.title.length > MENU_LIMITS.persistentTitle) return `القائمة الثابتة: العنوان أطول من ${MENU_LIMITS.persistentTitle} حرف`;
    if (p.url ? !/^https:\/\//.test(p.url) : !p.key || !findNode(m.root, p.key)) return `القائمة الثابتة: «${p.title}» يحتاج خيار من القائمة أو رابط يبدأ بـ https://`;
  }
  if ((m.persistent ?? []).length > MENU_LIMITS.persistent) return `القائمة الثابتة: الحد ${MENU_LIMITS.persistent} عناصر`;
  return null;
}
