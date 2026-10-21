import { beforeEach, describe, expect, it } from "vitest";
import { DB, resetDb } from "./helpers";
import { wantsPublishScope } from "../src/worker/services/publish";

const DAY = 86_400_000;
async function tenant(plan: string): Promise<number> {
  const now = Date.now();
  const r = await DB.prepare("INSERT INTO tenants (name, plan_id, plan_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id").bind(`t-${plan}`, plan, now + 30 * DAY, now, now).first<{ id: number }>();
  return r!.id;
}
const mode = (m: string) => DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('publish_scope', ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(m)).run();

describe("publishing permission requested by plan", () => {
  beforeEach(async () => {
    await resetDb();
    await DB.prepare("UPDATE plans SET limits = json_set(limits, '$.scheduling', json(?)) WHERE id = 'max'").bind("true").run();
    await DB.prepare("UPDATE plans SET limits = json_set(limits, '$.scheduling', json(?)) WHERE id = 'basic'").bind("false").run();
  });

  it("automatic mode asks only customers whose active plan includes scheduling (and the owner)", async () => {
    const withIt = await tenant("max");
    const without = await tenant("basic");
    await mode("all");
    expect(await wantsPublishScope(DB, 1)).toBe(true);
    expect(await wantsPublishScope(DB, withIt)).toBe(true);
    expect(await wantsPublishScope(DB, without)).toBe(false);
    // expired plan: not asked
    await DB.prepare("UPDATE tenants SET plan_expires_at = ? WHERE id = ?").bind(Date.now() - DAY, withIt).run();
    expect(await wantsPublishScope(DB, withIt)).toBe(false);
  });

  it("owner-only and off modes", async () => {
    const withIt = await tenant("max");
    await mode("owner");
    expect(await wantsPublishScope(DB, 1)).toBe(true);
    expect(await wantsPublishScope(DB, withIt)).toBe(false);
    await mode("off");
    expect(await wantsPublishScope(DB, 1)).toBe(false);
    expect(await wantsPublishScope(DB, withIt)).toBe(false);
  });
});
