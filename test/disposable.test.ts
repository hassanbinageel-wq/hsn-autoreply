import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DB, resetDb } from "./helpers";
import { isDisposable, isDisposableEmail, refreshDisposableDomains } from "../src/worker/lib/disposable";

const BASE = "https://hsn.example.workers.dev";
const SELF = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const askCode = async (email: string) => {
  const r = await SELF.fetch(new Request(`${BASE}/api/auth/register/email-code`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify({ email }) }));
  return { status: r.status, body: (await r.json()) as any };
};

beforeEach(resetDb);

describe("throw-away email addresses", () => {
  // Real domains of each service (FakeFilter, 2026-10-24): temp-mail.org rotates through many domains.
  const THROWAWAY = [
    "xatis77034@hiringview.com", // temp-mail.org (the address from the owner's test)
    "a@ifcoat.com", "a@nriza.com", "a@bmoar.com", "a@playfine.com", // temp-mail.org
    "a@mailinator.com", "a@mailinator.net", // mailinator
    "a@yopmail.com", "a@yopmail.fr", "a@yopmail.net", "a@jetable.org", // yopmail
    "a@10minutemail.com", "a@vtmpj.net", // 10minutemail
    "a@guerrillamail.com", "a@sharklasers.com", // guerrilla mail
    "a@x.mailinator.com", // a sub-domain of one
  ];
  const REAL = ["a@gmail.com", "a@outlook.com", "a@hotmail.com", "a@icloud.com", "a@yahoo.com", "a@shayyek.sa", "a@stc.com.sa"];

  it("recognises temp-mail.org, mailinator, yopmail and others, never the usual providers", () => {
    for (const e of THROWAWAY) expect(isDisposableEmail(e), e).toBe(true);
    for (const e of REAL) expect(isDisposableEmail(e), e).toBe(false);
  });

  it("the free sign-up refuses them before sending a code, with a clear message", async () => {
    for (const e of ["xatis77034@hiringview.com", "a@mailinator.com", "a@yopmail.com"]) {
      const r = await askCode(e);
      expect(r.status, e).toBe(422);
      expect(r.body.error.code).toBe("email_disposable");
      expect(r.body.error.message).toContain("المؤقتة");
    }
  });

  it("the daily refresh adds domains the lists gained after this build", async () => {
    expect(await isDisposable(DB, "a@brand-new-temp.example")).toBe(false);
    const fake = (async (url: string) => new Response(String(url).includes("fakefilter") ? "# header\nbrand-new-temp.example\ngmail.com\n" : "mailinator.com\n")) as unknown as typeof fetch;
    expect(await refreshDisposableDomains(DB, fake)).toBe(1); // gmail never; mailinator already known
    expect(await isDisposable(DB, "a@brand-new-temp.example")).toBe(true);
    expect(await isDisposable(DB, "a@gmail.com")).toBe(false);
  });
});
