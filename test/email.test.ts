import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lastEmailError, sendEmail } from "../src/worker/services/email";
import { resetDb } from "./helpers";

const MAIL = { to: "a@example.com", subject: "s", text: "t", html: "<p>t</p>" };
const E = (over: Record<string, string>) => ({ ...(env as any), RESEND_API_KEY: "re_test", ...over });

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

describe("email sender fallback", () => {
  it("retries from EMAIL_FROM_FALLBACK when Resend refuses the main sender, and records the failure", async () => {
    const froms: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      const from = JSON.parse(String(init.body)).from as string;
      froms.push(from);
      return from.includes("new.example") ? new Response('{"message":"domain not verified"}', { status: 403 }) : new Response("{}", { status: 200 });
    }));
    const r = await sendEmail(E({ EMAIL_FROM: "X <no-reply@new.example>", EMAIL_FROM_FALLBACK: "X <no-reply@old.example>" }), MAIL);
    expect(r.ok).toBe(true);
    expect(froms).toEqual(["X <no-reply@new.example>", "X <no-reply@old.example>"]);
    expect((await lastEmailError(env as any))?.error).toContain("403");
  });

  it("does not retry on success, and reports the error when both fail", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    expect((await sendEmail(E({ EMAIL_FROM: "X <a@new.example>", EMAIL_FROM_FALLBACK: "X <a@old.example>" }), MAIL)).ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect(await lastEmailError(env as any)).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 422 })));
    const r = await sendEmail(E({ EMAIL_FROM: "X <a@new.example>", EMAIL_FROM_FALLBACK: "X <a@old.example>" }), MAIL);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("422");
  });
});
