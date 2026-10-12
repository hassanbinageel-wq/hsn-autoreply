import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DB, makeCtx, MockMeta, resetDb, seedAccount } from "./helpers";
import { fetchBatch, pickNext } from "../src/worker/services/draws";

const BASE = "https://hsn.example.workers.dev";
const SELF = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
let H: Record<string, string> = {};

async function req(path: string, method = "GET", body?: unknown) {
  const r = await SELF.fetch(new Request(BASE + path, { method, headers: { "Content-Type": "application/json", ...H }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: r.status, body: (await r.json()) as any };
}
const ops = async () => (await req("/api/undo")).body as any[];
const campaign = (name: string, extra: Record<string, unknown> = {}) => ({
  name, type: "comment", final_text: "هذا المحتوى", keywords: [{ keyword: "كورس", kind: "include", match_type: "contains" }], media_ids: [], ...extra,
});

beforeEach(async () => {
  await resetDb();
  await seedAccount();
  await SELF.fetch(new Request(BASE + "/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" }) }));
  const r = await SELF.fetch(new Request(BASE + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "a-very-strong-password", client: "web" }) }));
  const b = (await r.json()) as any;
  H = { Cookie: (r.headers.get("Set-Cookie") ?? "").split(";")[0], "X-CSRF-Token": b.csrf_token };
});

describe("undo of recent operations", () => {
  it("reverts a campaign edit (texts + keywords), then its creation", async () => {
    const { body: c } = await req("/api/campaigns", "POST", campaign("أ"));
    await req(`/api/campaigns/${c.id}`, "PUT", campaign("ب", { final_text: "نص جديد", keywords: [{ keyword: "دورة", kind: "include", match_type: "contains" }] }));
    let list = await ops();
    expect(list.map((o) => o.kind)).toEqual(["campaign.update", "campaign.create"]);
    // The creation is blocked until the newer edit on the same campaign is reverted.
    expect(list[1].revertible).toBe(false);
    expect((await req(`/api/undo/${list[1].id}`, "POST")).status).toBe(409);

    expect((await req(`/api/undo/${list[0].id}`, "POST")).status).toBe(200);
    const row = await DB.prepare("SELECT name, final_text FROM campaigns WHERE id = ?").bind(c.id).first<any>();
    expect(row).toEqual({ name: "أ", final_text: "هذا المحتوى" });
    const kw = await DB.prepare("SELECT keyword FROM campaign_keywords WHERE campaign_id = ?").bind(c.id).all<any>();
    expect(kw.results.map((k) => k.keyword)).toEqual(["كورس"]);
    expect((await req(`/api/undo/${list[0].id}`, "POST")).status).toBe(409); // not twice

    list = await ops();
    expect(list[1].revertible).toBe(true);
    await req(`/api/undo/${list[1].id}`, "POST");
    expect((await DB.prepare("SELECT deleted_at FROM campaigns WHERE id = ?").bind(c.id).first<any>()).deleted_at).toBeTruthy();
  });

  it("restores a deleted campaign with its previous status, re-activated from now", async () => {
    const { body: c } = await req("/api/campaigns", "POST", campaign("حملة"));
    await req(`/api/campaigns/${c.id}/status`, "POST", { status: "active" });
    await DB.prepare("UPDATE campaigns SET activated_at = 1 WHERE id = ?").bind(c.id).run();
    await req(`/api/campaigns/${c.id}`, "DELETE");
    const del = (await ops())[0];
    expect(del.kind).toBe("campaign.delete");
    await req(`/api/undo/${del.id}`, "POST");
    const row = await DB.prepare("SELECT status, deleted_at, activated_at FROM campaigns WHERE id = ?").bind(c.id).first<any>();
    expect(row.status).toBe("active");
    expect(row.deleted_at).toBeNull();
    expect(row.activated_at).toBeGreaterThan(Date.now() - 60_000);
  });

  it("restores a deleted draw with its entries and winners", async () => {
    const { body: c } = await req("/api/campaigns", "POST", campaign("حملة"));
    const now = Date.now();
    const d = await DB.prepare(
      `INSERT INTO draws (campaign_id, name, source_type, media_id, winners_count, exclude_own, excluded_accounts, entry_mode, created_at, updated_at)
       VALUES (?, 'سحب', 'media', 'm1', 1, 1, '[]', 'per_person', ?, ?) RETURNING id`,
    ).bind(c.id, now, now).first<{ id: number }>();
    const meta = new MockMeta();
    meta.commentPages["m1"] = [[
      { id: "c1", text: "a", timestamp: new Date().toISOString(), from: { id: "U1", username: "u1" } },
      { id: "c2", text: "b", timestamp: new Date().toISOString(), from: { id: "U2", username: "u2" } },
    ]];
    await fetchBatch(makeCtx(meta), d!.id);
    await pickNext(DB, d!.id, "req_u1");
    const winnerBefore = await DB.prepare("SELECT entry_id FROM draw_winners WHERE draw_id = ?").bind(d!.id).first<any>();
    await req(`/api/draws/${d!.id}`, "DELETE");
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM draw_entries").first<any>()).n).toBe(0);
    const op = (await ops())[0];
    expect((await req(`/api/undo/${op.id}`, "POST")).status).toBe(200);
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM draw_entries WHERE draw_id = ?").bind(d!.id).first<any>()).n).toBe(2);
    expect(await DB.prepare("SELECT entry_id FROM draw_winners WHERE draw_id = ?").bind(d!.id).first<any>()).toEqual(winnerBefore);
    expect((await DB.prepare("SELECT status FROM draws WHERE id = ?").bind(d!.id).first<any>()).status).toBe("drawn");
  });

  it("reverts template and settings changes and keeps only the last 10 operations", async () => {
    const { body: t } = await req("/api/templates", "POST", { kind: "final", name: "قالب", body: "نص" });
    await req(`/api/templates/${t.id}`, "DELETE");
    await req(`/api/undo/${(await ops())[0].id}`, "POST");
    expect((await DB.prepare("SELECT name FROM templates WHERE id = ?").bind(t.id).first<any>()).name).toBe("قالب");

    await req("/api/settings", "PUT", { global_user_hourly_limit: 3 });
    await req(`/api/undo/${(await ops())[0].id}`, "POST");
    expect((await DB.prepare("SELECT value FROM app_settings WHERE key = 'global_user_hourly_limit'").first<any>()).value).toBe("10");

    for (let i = 0; i < 12; i++) await req("/api/templates", "POST", { kind: "final", name: `ق${i}`, body: "x" });
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM undo_ops").first<any>()).n).toBe(10);
  });
});
