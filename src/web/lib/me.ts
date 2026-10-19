/** Who is signed in (set by the app shell from /api/auth/me): the account holder or a staff login and its sections. */
export const me = { role: "owner" as "owner" | "staff", perms: [] as string[], display_name: null as string | null, is_owner: false };
export const setMe = (v: Partial<typeof me>) => Object.assign(me, v);
export const isStaff = () => me.role === "staff";
export const hasPerm = (p: string) => me.role !== "staff" || me.perms.includes(p);
