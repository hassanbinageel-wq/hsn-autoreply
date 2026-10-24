/**
 * How much of the cycle's messages is gone, 0–100: what is left measured against the plan's own messages (or the
 * total, when messages were added). Messages the owner took off count as gone — a 100-message plan with 95 taken
 * off and none used is at 95%, like its bar.
 */
export function messagesGonePct(used: number, limit: number | null, planLimit?: number | null): number {
  if (limit === null) return 0;
  const base = Math.max(limit, planLimit ?? 0);
  if (base <= 0) return 100;
  return Math.max(0, Math.min(100, (1 - Math.max(0, limit - used) / base) * 100));
}
