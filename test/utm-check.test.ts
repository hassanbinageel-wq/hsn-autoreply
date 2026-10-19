import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const SELF = (exports as any).default as { fetch: (r: Request) => Promise<Response> };

describe("temporary UTM check page", () => {
  it("shows the tags a link arrived with, escaped", async () => {
    const ok = await (await SELF.fetch(new Request("https://hsn.example.workers.dev/utm-check?utm_source=instagram&utm_medium=hsn&utm_campaign=%D8%AA%D8%AC%D8%B1%D8%A8%D8%A9"))).text();
    expect(ok).toContain("✅");
    expect(ok).toContain("تجربة");
    const bad = await (await SELF.fetch(new Request("https://hsn.example.workers.dev/utm-check?utm_campaign=%3Cscript%3E"))).text();
    expect(bad).toContain("❌");
    expect(bad).not.toContain("<script>");
  });
});
