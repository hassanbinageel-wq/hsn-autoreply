import type { StaffPerm } from "../../shared/staff";

/**
 * Which API routes a staff login may call. Paths are relative to /api. Anything not listed is for the account
 * holder only (settings, connection, subscription, store connection, notifications, staff, data deletion…).
 * Default deny: a new route stays closed to staff until it is added here.
 */
type Rule = { re: RegExp; perms: StaffPerm[] | "any"; read?: boolean };

const RULES: Rule[] = [
  // Every staff member: their own login, the bell, and read-only views the app shell needs.
  { re: /^\/auth\/(me|logout|sessions|sessions\/revoke-others|totp(\/(setup|enable|disable))?)$/, perms: "any" },
  { re: /^\/account\/email(\/verify)?$/, perms: "any" },
  { re: /^\/account\/password(\/confirm)?$/, perms: "any" },
  { re: /^\/app-notifications(\/.*)?$/, perms: "any" },
  { re: /^\/(dashboard|account|settings|subscription|usage)$/, perms: "any", read: true },

  { re: /^\/(inbox|inbox-labels|saved-replies)(\/.*)?$/, perms: ["inbox"] },
  { re: /^\/(campaigns|templates)(\/.*)?$/, perms: ["campaigns"] },
  { re: /^\/campaigns(\/.*)?$/, perms: ["analytics"], read: true },
  { re: /^\/simulate$/, perms: ["campaigns"] },
  { re: /^\/media(\/refresh)?$/, perms: ["campaigns", "schedule", "draws"] },
  { re: /^\/growth\/best-times$/, perms: ["schedule"], read: true },
  { re: /^\/growth\/posts$/, perms: ["store"], read: true },
  { re: /^\/schedule(\/.*)?$/, perms: ["schedule"] },
  { re: /^\/(draws|card-designs)(\/.*)?$/, perms: ["draws"] },
  { re: /^\/(analytics|growth)(\/.*)?$/, perms: ["analytics"] },
  { re: /^\/store\/(analytics|campaigns\/\d+|products|costs)$/, perms: ["store"] },
  { re: /^\/stores$/, perms: ["store"], read: true },
  { re: /^\/(logs|flows|jobs|audit|undo|recover)(\/.*)?$/, perms: ["logs"] },

  // The service owner's panel (only exists for the owner account).
  { re: /^\/owner\/(tenants|health|broadcast|messages|message-templates)(\/.*)?$/, perms: ["owner_customers"] },
  { re: /^\/owner\/support(\/.*)?$/, perms: ["owner_support"] },
  { re: /^\/owner\/(plans|codes|coupons|referral|feature-order|featured-plan)(\/.*)?$/, perms: ["owner_plans"] },
  { re: /^\/owner\/payment-(providers|accounts|methods)(\/.*)?$/, perms: ["owner_payments"] },
  { re: /^\/owner\/(branding|login-banner|settings)$/, perms: ["owner_branding"] },
];

export function staffAllowed(method: string, path: string, perms: string[]): boolean {
  const isRead = method === "GET" || method === "HEAD";
  return RULES.some((r) => r.re.test(path) && (!r.read || isRead) && (r.perms === "any" || r.perms.some((p) => perms.includes(p))));
}

export function parsePerms(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
