import { beforeEach, describe, expect, it } from "vitest";
import { DB, resetDb, seedAccount, TEST_ENV } from "./helpers";
import { completeSallaOAuth, handleSallaWebhook, stockOf } from "../src/worker/services/salla";
import { buildMessage, OUT_OF_STOCK_TEXT } from "../src/worker/engine/executor";
import { recordMessage } from "../src/worker/services/inbox";
import { runRestock, waitlistStats } from "../src/worker/services/restock";

const URL_ = "https://demo.salla.sa/p555/jacket";

function fakeSalla() {
  return (async (u: string) => {
    if (String(u).endsWith("/oauth2/token")) return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 1209600 }));
    if (String(u).endsWith("/oauth2/user/info")) return new Response(JSON.stringify({ data: { merchant: { id: 9001, name: "متجر" } } }));
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}
const product = (quantity: number) => ({ event: "product.updated", merchant: 9001, data: { id: 555, name: "جاكيت", quantity, status: quantity > 0 ? "sale" : "out", urls: { customer: URL_ } } });

async function campaign(action: string) {
  const now = Date.now();
  const c = await DB.prepare("INSERT INTO campaigns (tenant_id, name, type, status, final_text, final_url, stock_action, created_at, updated_at) VALUES (1, 'ريل الجاكيت', 'comment', 'active', 'تفضل {{content_url}}', ?, ?, ?, ?) RETURNING *")
    .bind(URL_, action, now, now)
    .first<any>();
  return c;
}
const camp = async (id: number) => DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<any>();

beforeEach(async () => {
  await resetDb();
  await seedAccount();
  await completeSallaOAuth(TEST_ENV, "c", 1, fakeSalla());
  await handleSallaWebhook(TEST_ENV, product(5));
});

describe("stock: alerts, pause, waitlist", () => {
  it("reads availability the ways Salla may send it", () => {
    expect(stockOf({ status: "out" }).stock).toBe("out");
    expect(stockOf({ quantity: 0 }).stock).toBe("out");
    expect(stockOf({ quantity: 0, unlimited_quantity: true }).stock).toBe("in");
    expect(stockOf({ quantity: "3" })).toEqual({ stock: "in", quantity: 3 });
    expect(stockOf({ name: "x" }).stock).toBeNull();
  });

  it("pauses a campaign whose product ran out and resumes it when the product is back", async () => {
    const c = await campaign("pause");
    await handleSallaWebhook(TEST_ENV, product(0));
    expect(await camp(c.id)).toMatchObject({ status: "paused", stock_paused: 1 });
    expect((await camp(c.id)).stock_out_at).toBeGreaterThan(0);
    expect((await DB.prepare("SELECT stock_status FROM store_products WHERE product_id = '555'").first<any>()).stock_status).toBe("out");
    await handleSallaWebhook(TEST_ENV, product(4));
    expect(await camp(c.id)).toMatchObject({ status: "active", stock_paused: 0, stock_out_at: null });
    // the in-app bell got the important notifications (no Telegram set up): out, back, and the story suggestion
    const notes = (await DB.prepare("SELECT kind, title, link FROM app_notifications WHERE tenant_id = 1 ORDER BY id").all<any>()).results;
    expect(notes.map((n: any) => n.kind)).toEqual(["stock", "stock", "story"]);
    expect(notes[0]).toMatchObject({ link: "/store" });
    expect(notes[0].title).toContain("نفد من المخزون: جاكيت");
    expect(notes[2]).toMatchObject({ link: "/schedule" });
    expect(notes[2].title).toContain("حان وقت ستوري");
    // a campaign the merchant paused by hand is never resumed by stock
    await DB.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").bind(c.id).run();
    await handleSallaWebhook(TEST_ENV, product(0));
    await handleSallaWebhook(TEST_ENV, product(2));
    expect((await camp(c.id)).status).toBe("paused");
  });

  it("waitlist: out-of-stock reply without the link, «بلغني» joins, back in stock sends once within 24 h only", async () => {
    const c = await campaign("waitlist");
    await handleSallaWebhook(TEST_ENV, product(0));
    const out = await camp(c.id);
    expect(out.status).toBe("active");
    const acc = await DB.prepare("SELECT * FROM instagram_accounts").first<any>();
    const msg = buildMessage("content", { campaign: out, account: acc, participant: { username: "sara" } as any, flow: {} as any }, "private_reply");
    expect(msg.text).toContain("خلص");
    expect(msg.text).not.toContain(URL_);
    expect(OUT_OF_STOCK_TEXT).toContain("بلغني");

    const now = Date.now();
    const people: number[] = [];
    for (const [i, last] of [[1, now - 3_600_000], [2, now - 30 * 3_600_000]] as const) {
      const p = await DB.prepare("INSERT INTO participants (account_id, igsid, username, last_user_message_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id").bind(acc.id, `ig${i}`, `user${i}`, last, now, now).first<any>();
      await DB.prepare(
        `INSERT INTO conversation_flows (account_id, campaign_id, participant_id, trigger_type, source_comment_id, state, start_token, verify_token, private_reply_status, created_at, updated_at)
         VALUES (?, ?, ?, 'comment', ?, 'content_sent', ?, ?, 'accepted', ?, ?)`,
      ).bind(acc.id, c.id, p.id, `cm${i}`, `st_${i}aaaaaaaaaaaaaaa`, `vt_${i}aaaaaaaaaaaaaaa`, now, now).run();
      await recordMessage(DB, { accountId: acc.id, participantId: p.id, direction: "in", source: "user", text: "بلغني", at: last });
      people.push(p.id);
    }
    expect(await waitlistStats(DB, 1, c.id)).toMatchObject({ waiting: 2 });
    expect(await waitlistStats(DB, 999, c.id)).toMatchObject({ waiting: 0 });
    // nothing is sent while the product is still out
    const sent: string[] = [];
    const deps = { token: async () => "tok", send: async (_t: string, _a: any, igsid: string, m: any) => (sent.push(`${igsid}:${m.text}`), { ok: true as const, data: { message_id: `m-${igsid}` } }) };
    expect(await runRestock(TEST_ENV, 10, now, deps as any)).toBe(0);
    await handleSallaWebhook(TEST_ENV, product(3));
    await runRestock(TEST_ENV, 10, now, deps as any);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("ig1:");
    expect(sent[0]).toContain(URL_);
    expect(await waitlistStats(DB, 1, c.id)).toMatchObject({ waiting: 0, sent: 1, window_closed: 1 });
    // run again: no duplicate
    await runRestock(TEST_ENV, 10, now, deps as any);
    expect(sent).toHaveLength(1);
  });

  it("«بلغني» without an out-of-stock waitlist campaign records nothing", async () => {
    await campaign("notify");
    const acc = await DB.prepare("SELECT * FROM instagram_accounts").first<any>();
    const now = Date.now();
    const p = await DB.prepare("INSERT INTO participants (account_id, igsid, created_at, updated_at) VALUES (?, 'x', ?, ?) RETURNING id").bind(acc.id, now, now).first<any>();
    await recordMessage(DB, { accountId: acc.id, participantId: p.id, direction: "in", source: "user", text: "بلغني", at: now });
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM restock_waitlist").first<any>()).n).toBe(0);
  });
});
