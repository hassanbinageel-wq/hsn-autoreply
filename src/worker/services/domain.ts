import type { Env } from "../env";
import { getSetting, OWNER_TENANT, setSetting } from "../lib/db";

/**
 * The service domain's registration and expiry dates, read from the public RDAP registry record (the official
 * successor of WHOIS). Cached for a day. If the domain expires, the whole service stops — so the owner is told early.
 */
export interface DomainInfo {
  name: string;
  registered_at: number | null;
  expires_at: number | null;
  registrar: string | null;
  checked_at: number;
  error?: string;
}

export function serviceDomain(env: Env): string | null {
  if (env.SERVICE_DOMAIN && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(env.SERVICE_DOMAIN)) return env.SERVICE_DOMAIN.toLowerCase();
  try {
    const host = new URL(env.PUBLIC_BASE_URL).hostname.replace(/^www\./, "");
    return host.endsWith(".workers.dev") ? null : host;
  } catch {
    return null;
  }
}

export function parseRdap(name: string, j: any, now = Date.now()): DomainInfo {
  const ev = (a: string) => {
    const e = (j?.events ?? []).find((x: any) => x?.eventAction === a);
    const t = e ? Date.parse(e.eventDate) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const reg = (j?.entities ?? []).find((e: any) => (e?.roles ?? []).includes("registrar"));
  const fn = reg?.vcardArray?.[1]?.find((v: any) => v?.[0] === "fn")?.[3];
  return { name, registered_at: ev("registration"), expires_at: ev("expiration"), registrar: typeof fn === "string" ? fn : null, checked_at: now };
}

export async function domainInfo(env: Env, now = Date.now(), force = false): Promise<DomainInfo | null> {
  const name = serviceDomain(env);
  if (!name) return null;
  const cached = await getSetting<DomainInfo | null>(env.DB, OWNER_TENANT, "domain_info", null);
  if (!force && cached && cached.name === name && now - cached.checked_at < 86_400_000) return cached;
  const tld = name.split(".").pop()!;
  const headers = { Accept: "application/rdap+json, application/json", "User-Agent": "HSN-AutoReply/1.0 (+https://hsnreply.online)" };
  // The registry's RDAP server from IANA's official bootstrap file, then known fallbacks.
  const bases: string[] = [];
  try {
    const boot = (await (await fetch("https://data.iana.org/rdap/dns.json", { headers })).json()) as { services?: Array<[string[], string[]]> };
    for (const [tlds, urls] of boot.services ?? []) if (tlds.includes(tld)) bases.push(...urls);
  } catch {
    /* fallbacks below */
  }
  if (tld === "online") bases.push("https://rdap.centralnic.com/online/");
  bases.push("https://rdap.org/");
  let info: DomainInfo = { name, registered_at: null, expires_at: null, registrar: null, checked_at: now, error: "تعذّر قراءة سجل الدومين" };
  const tried: string[] = [];
  for (const base of [...new Set(bases)]) {
    const u = `${base.replace(/\/$/, "")}/domain/${name}`;
    try {
      const r = await fetch(u, { headers, redirect: "follow" });
      if (!r.ok) {
        tried.push(`${new URL(u).hostname}: HTTP ${r.status}`);
        continue;
      }
      info = parseRdap(name, await r.json(), now);
      if (info.expires_at) break;
      tried.push(`${new URL(u).hostname}: بدون تاريخ انتهاء`);
    } catch (e) {
      tried.push(`${new URL(u).hostname}: ${(e as Error).message.slice(0, 60)}`);
    }
  }
  if (!info.expires_at) info.error = `تعذّر قراءة سجل الدومين (${tried.join("، ") || "بدون رد"})`;
  await setSetting(env.DB, OWNER_TENANT, "domain_info", info, now);
  return info;
}
