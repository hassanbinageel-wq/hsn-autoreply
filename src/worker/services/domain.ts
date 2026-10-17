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
  const tld = name.split(".").pop();
  // The registry's RDAP server for the TLD, with rdap.org (a public redirector) as the fallback.
  const urls = [...(tld === "online" ? [`https://rdap.centralnic.com/online/domain/${name}`] : []), `https://rdap.org/domain/${name}`];
  let info: DomainInfo = { name, registered_at: null, expires_at: null, registrar: null, checked_at: now, error: "تعذّر قراءة سجل الدومين" };
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { Accept: "application/rdap+json" }, redirect: "follow" });
      if (!r.ok) continue;
      info = parseRdap(name, await r.json(), now);
      if (info.expires_at) break;
    } catch {
      /* next */
    }
  }
  await setSetting(env.DB, OWNER_TENANT, "domain_info", info, now);
  return info;
}
