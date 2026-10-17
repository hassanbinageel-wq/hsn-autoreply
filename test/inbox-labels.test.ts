import { beforeEach, describe, expect, it } from "vitest";
import { DB, resetDb, seedAccount } from "./helpers";
import { recordMessage, suggestLabel } from "../src/worker/services/inbox";

beforeEach(async () => {
  await resetDb();
  await seedAccount();
});

describe("inbox labels", () => {
  it("suggests a label from the person's words: complaint > order > inquiry", () => {
    expect(suggestLabel("بكم الجاكيت؟")).toBe("inquiry");
    expect(suggestLabel("هل متوفر مقاس L")).toBe("inquiry");
    expect(suggestLabel("ابي اطلب ٢ حبة")).toBe("order");
    expect(suggestLabel("طلبي متأخر وما وصل للحين")).toBe("complaint");
    expect(suggestLabel("أهلاً")).toBeNull(); // a greeting is not a question
    expect(suggestLabel("")).toBeNull();
  });

  it("labels a conversation from incoming messages, and never overrides the merchant's own label", async () => {
    const acc = await DB.prepare("SELECT id FROM instagram_accounts").first<any>();
    const now = Date.now();
    const p = await DB.prepare("INSERT INTO participants (account_id, igsid, created_at, updated_at) VALUES (?, 'u1', ?, ?) RETURNING id").bind(acc.id, now, now).first<any>();
    const msg = (text: string, direction: "in" | "out" = "in") => recordMessage(DB, { accountId: acc.id, participantId: p.id, direction, source: direction === "in" ? "user" : "manual", text, at: Date.now() });
    const label = async () => (await DB.prepare("SELECT inbox_label, inbox_label_source FROM participants WHERE id = ?").bind(p.id).first<any>());
    await msg("كم السعر؟");
    expect(await label()).toMatchObject({ inbox_label: "inquiry", inbox_label_source: "auto" });
    await msg("وصلني تالف", "out"); // our own message never labels
    expect((await label()).inbox_label).toBe("inquiry");
    await msg("ابي اطلب");
    expect((await label()).inbox_label).toBe("order");
    await DB.prepare("UPDATE participants SET inbox_label = 'other', inbox_label_source = 'manual' WHERE id = ?").bind(p.id).run();
    await msg("المنتج وصلني مكسور");
    expect(await label()).toMatchObject({ inbox_label: "other", inbox_label_source: "manual" });
  });
});
