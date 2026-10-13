import { all } from "../lib/db";

export interface PaymentAccount {
  id: number;
  holder: string;
  number: string;
  currency: string | null;
  note: string | null;
}
export interface PaymentProvider {
  id: number;
  name: string;
  kind: "bank" | "exchange";
  logo: string | null;
  accounts: PaymentAccount[];
}

/** Banks / exchange offices with their accounts, in the owner's order (platform-wide, shown to everyone). */
export async function listPaymentMethods(db: D1Database): Promise<PaymentProvider[]> {
  const [providers, accounts] = await Promise.all([
    all<Omit<PaymentProvider, "accounts">>(db, "SELECT id, name, kind, logo FROM payment_providers ORDER BY sort, id"),
    all<PaymentAccount & { provider_id: number }>(db, "SELECT id, provider_id, holder, number, currency, note FROM payment_accounts ORDER BY sort, id"),
  ]);
  return providers.map((p) => ({ ...p, accounts: accounts.filter((a) => a.provider_id === p.id).map(({ provider_id: _, ...a }) => a) }));
}
