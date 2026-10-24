/**
 * Staff permissions: the sections an account holder can give a staff login. The server checks every request
 * against these (src/worker/services/staff.ts); the app only hides what the staff member cannot open.
 */
export type StaffPerm =
  | "inbox" | "campaigns" | "schedule" | "draws" | "analytics" | "store" | "logs"
  | "owner_customers" | "owner_support" | "owner_plans" | "owner_payments" | "owner_branding";

export const STAFF_PERMS: Array<{ key: StaffPerm; label: string; hint: string; ownerOnly?: boolean }> = [
  { key: "inbox", label: "الرسائل", hint: "يقرأ المحادثات ويرد عليها، والردود الجاهزة والتصنيفات" },
  { key: "campaigns", label: "الحملات والقوالب", hint: "ينشئ ويعدّل الحملات والقوالب، والمحاكاة، والمنشورات" },
  { key: "schedule", label: "الجدولة والنشر", hint: "يجدول المنشورات والريلز والستوري" },
  { key: "draws", label: "السحوبات", hint: "السحوبات وبطاقات التهنئة" },
  { key: "analytics", label: "التحليلات والتقارير", hint: "يشوف أرقام الحملات والتقرير الأسبوعي (قراءة)" },
  { key: "store", label: "تحليل المتجر", hint: "يشوف مبيعات المتجر وتكلفة المنتجات" },
  { key: "logs", label: "السجل", hint: "سجل الأحداث والتشخيص واسترجاع العمليات" },
  { key: "owner_customers", label: "إدارة العملاء", hint: "العملاء وصحتهم والرسائل والإشعارات لهم والتشخيص", ownerOnly: true },
  { key: "owner_support", label: "دعم العملاء", hint: "يقرأ رسائل الدعم ويرد عليها", ownerOnly: true },
  { key: "owner_plans", label: "الباقات والأكواد", hint: "الباقات وأكواد التفعيل والكوبونات والإحالة", ownerOnly: true },
  { key: "owner_payments", label: "الحسابات البنكية", hint: "حسابات وطرق الدفع اللي تظهر للعملاء", ownerOnly: true },
  { key: "owner_branding", label: "صفحة الدخول والهوية", hint: "بنر صفحة الدخول ورابط التطبيق", ownerOnly: true },
];

export const permsFor = (isOwnerTenant: boolean) => STAFF_PERMS.filter((p) => isOwnerTenant || !p.ownerOnly);

/** App pages and the permissions that open them (any one is enough). Pages not listed are for the account holder. */
export const PAGE_PERMS: Record<string, StaffPerm[] | "all"> = {
  "/": "all",
  "/download": "all",
  "/settings": "all", // staff see only their own login settings (email, two-step login)
  "/campaigns": ["campaigns", "analytics"],
  "/schedule": ["schedule"],
  "/analytics": ["analytics"],
  "/store": ["store"],
  "/inbox": ["inbox"],
  "/draws": ["draws"],
  "/templates": ["campaigns"],
  "/simulator": ["campaigns"],
  "/logs": ["logs"],
  "/report": ["analytics"],
  "/owner": ["owner_customers", "owner_support", "owner_plans", "owner_payments", "owner_branding"],
};

export function canOpenPage(path: string, role: string | undefined, perms: string[]): boolean {
  if (role !== "staff") return true;
  const base = "/" + (path.split("/")[1] ?? "");
  const need = PAGE_PERMS[base];
  if (!need) return false;
  return need === "all" || need.some((p) => perms.includes(p));
}
