import { all, first } from "../lib/db";

/**
 * Store analytics: orders and revenue from the connected store, joined to the customer's campaigns.
 * Attribution is stated honestly:
 *  - by coupon (exact): an order that used a campaign's discount code belongs to that campaign;
 *  - by product link (indicative): a campaign whose link points to a product, compared with that product's orders —
 *    an order without the code may have come from elsewhere, so it is never counted as the campaign's.
 * Cancelled / refunded / deleted orders are excluded from revenue. Everything is scoped to the customer.
 */

const NOT_COUNTED = ["canceled", "cancelled", "refunded", "restored", "deleted"];
const DAY = 86_400_000;

export function normalizeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, "")}${decodeURIComponent(x.pathname).replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return null;
  }
}

export async function storeAnalytics(db: D1Database, t: number, f: { from: number; to: number; tzOffsetMin: number }) {
  const store = await first<{ id: number; name: string | null; domain: string | null; status: string; products_synced_at: number | null; connected_at: number }>(
    db,
    "SELECT id, name, domain, status, products_synced_at, connected_at FROM stores WHERE tenant_id = ? AND platform = 'salla' AND status != 'disconnected' ORDER BY id DESC LIMIT 1",
    t,
  );
  if (!store) return { store: null };
  const notIn = NOT_COUNTED.map(() => "?").join(",");
  const orders = await all<{ order_id: string; status: string | null; total: number | null; currency: string | null; coupon: string | null; items: string; ordered_at: number }>(
    db,
    `SELECT order_id, status, total, currency, coupon, items, ordered_at FROM store_orders
      WHERE store_id = ? AND deleted = 0 AND ordered_at >= ? AND ordered_at < ? ORDER BY ordered_at LIMIT 20000`,
    store.id,
    f.from,
    f.to,
  );
  const counted = orders.filter((o) => !NOT_COUNTED.includes((o.status ?? "").toLowerCase()));
  const revenue = counted.reduce((a, o) => a + (o.total ?? 0), 0);
  const currency = counted.find((o) => o.currency)?.currency ?? "SAR";

  // Campaigns: coupon + link, with their clicks / deliveries in the period.
  const campaigns = await all<{ id: number; name: string; status: string; store_coupon: string | null; final_url: string | null }>(
    db,
    "SELECT id, name, status, store_coupon, final_url FROM campaigns WHERE tenant_id = ? AND deleted_at IS NULL",
    t,
  );
  const clicks = await all<{ campaign_id: number; clicks: number; people: number }>(
    db,
    `SELECT f.campaign_id, COUNT(*) AS clicks, COUNT(DISTINCT f.participant_id) AS people FROM link_clicks k
       JOIN conversation_flows f ON f.id = k.flow_id JOIN campaigns c ON c.id = f.campaign_id
      WHERE c.tenant_id = ? AND k.clicked_at >= ? AND k.clicked_at < ? GROUP BY f.campaign_id`,
    t,
    f.from,
    f.to,
  );
  const delivered = await all<{ campaign_id: number; people: number }>(
    db,
    `SELECT f.campaign_id, COUNT(DISTINCT f.participant_id) AS people FROM conversation_flows f JOIN campaigns c ON c.id = f.campaign_id
      WHERE c.tenant_id = ? AND f.is_demo = 0 AND f.state = 'content_sent' AND f.content_delivered_at >= ? AND f.content_delivered_at < ? GROUP BY f.campaign_id`,
    t,
    f.from,
    f.to,
  );
  const products = await all<{ product_id: string; name: string | null; url: string | null; image_url: string | null; price: number | null; status: string | null }>(
    db,
    "SELECT product_id, name, url, image_url, price, status FROM store_products WHERE store_id = ?",
    store.id,
  );
  const productByUrl = new Map(products.map((p) => [normalizeUrl(p.url), p]).filter(([k]) => k) as Array<[string, (typeof products)[number]]>);

  const byCoupon = new Map<string, { orders: number; revenue: number }>();
  for (const o of counted) {
    if (!o.coupon) continue;
    const x = byCoupon.get(o.coupon) ?? { orders: 0, revenue: 0 };
    x.orders++;
    x.revenue += o.total ?? 0;
    byCoupon.set(o.coupon, x);
  }
  const campaignRows = campaigns
    .map((c) => {
      const code = c.store_coupon?.trim().toUpperCase() || null;
      const fromCode = code ? byCoupon.get(code) ?? { orders: 0, revenue: 0 } : null;
      const product = productByUrl.get(normalizeUrl(c.final_url) ?? "") ?? null;
      const cl = clicks.find((x) => x.campaign_id === c.id);
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        coupon: code,
        product: product ? { id: product.product_id, name: product.name } : null,
        delivered: delivered.find((x) => x.campaign_id === c.id)?.people ?? 0,
        clicks: cl?.clicks ?? 0,
        clickers: cl?.people ?? 0,
        orders: fromCode?.orders ?? null,
        revenue: fromCode?.revenue ?? null,
      };
    })
    .filter((c) => c.coupon || c.product || c.clicks > 0);
  const attributedCodes = new Set(campaignRows.map((c) => c.coupon).filter(Boolean));
  const attributed = counted.filter((o) => o.coupon && attributedCodes.has(o.coupon));

  // Products: units / orders / revenue from order items, plus the campaigns that link to each product.
  const perProduct = new Map<string, { units: number; orders: number; revenue: number; name: string | null }>();
  for (const o of counted) {
    let items: Array<{ product_id: string; name: string | null; qty: number; amount: number }> = [];
    try {
      items = JSON.parse(o.items || "[]");
    } catch {
      /* ignore */
    }
    const seen = new Set<string>();
    for (const i of items) {
      const x = perProduct.get(i.product_id) ?? { units: 0, orders: 0, revenue: 0, name: i.name };
      x.units += i.qty || 1;
      x.revenue += i.amount || 0;
      if (!seen.has(i.product_id)) x.orders++;
      seen.add(i.product_id);
      perProduct.set(i.product_id, x);
    }
  }
  const productRows = [...perProduct.entries()]
    .map(([id, x]) => {
      const p = products.find((pp) => pp.product_id === id);
      const linked = campaignRows.filter((c) => c.product?.id === id);
      return {
        id,
        name: p?.name ?? x.name,
        url: p?.url ?? null,
        image_url: p?.image_url ?? null,
        units: x.units,
        orders: x.orders,
        revenue: x.revenue || null,
        campaigns: linked.map((c) => ({ id: c.id, name: c.name })),
        clicks: linked.reduce((a, c) => a + c.clicks, 0),
      };
    })
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 100);

  const series = new Map<number, { orders: number; revenue: number }>();
  for (const o of counted) {
    const day = Math.floor((o.ordered_at + f.tzOffsetMin * 60_000) / DAY);
    const x = series.get(day) ?? { orders: 0, revenue: 0 };
    x.orders++;
    x.revenue += o.total ?? 0;
    series.set(day, x);
  }
  const firstDay = Math.floor((f.from + f.tzOffsetMin * 60_000) / DAY);
  const lastDay = Math.floor((f.to - 1 + f.tzOffsetMin * 60_000) / DAY);
  return {
    store: { ...store, products: products.length },
    totals: {
      orders: counted.length,
      revenue,
      aov: counted.length ? revenue / counted.length : 0,
      currency,
      excluded: orders.length - counted.length,
      attributed_orders: attributed.length,
      attributed_revenue: attributed.reduce((a, o) => a + (o.total ?? 0), 0),
    },
    campaigns: campaignRows.sort((a, b) => (b.orders ?? -1) - (a.orders ?? -1) || b.clicks - a.clicks),
    products: productRows,
    series: Array.from({ length: Math.max(0, Math.min(400, lastDay - firstDay + 1)) }, (_, i) => ({ day: firstDay + i, ...(series.get(firstDay + i) ?? { orders: 0, revenue: 0 }) })),
  };
}

/** The customer's store products, for linking a campaign to a product. */
export async function storeProducts(db: D1Database, t: number) {
  return all(
    db,
    `SELECT p.product_id, p.name, p.url, p.image_url, p.price, p.currency FROM store_products p JOIN stores s ON s.id = p.store_id
      WHERE s.tenant_id = ? AND s.status != 'disconnected' AND COALESCE(p.status, '') != 'deleted' ORDER BY p.updated_at DESC LIMIT 500`,
    t,
  );
}
