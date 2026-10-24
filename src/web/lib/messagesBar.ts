/**
 * The messages bar of a cycle shows what is LEFT (full when nothing is used, like the days bar), and a note on the
 * owner's changes: messages added on top of the plan, or taken off it.
 */
export function messagesLeft(used: number, limit: number | null): { pct: number; tone: string } {
  if (limit === null) return { pct: 100, tone: "bg-emerald-500" };
  const pct = limit <= 0 ? 0 : Math.max(0, Math.min(100, ((limit - used) / limit) * 100));
  return { pct, tone: pct <= 10 ? "bg-red-500" : pct <= 25 ? "bg-amber-500" : "bg-emerald-500" };
}

export function extraNote(extra: number): string | null {
  if (!extra) return null;
  const n = Math.abs(extra).toLocaleString("en-US");
  return extra > 0 ? `منها ${n} إضافية` : `تم خصم ${n}`;
}
