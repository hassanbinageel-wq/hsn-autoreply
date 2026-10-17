import { all, first } from "../lib/db";

/**
 * Store analytics: orders and revenue from the connected store, joined to the customer's campaigns.
 * Attribution is stated honestly:
 *  - by coupon (exact): an order that used a campaign's discount code belongs to that campaign;
 *  - by product link (indicative): a campaign whose link points to a product, compared with that product's orders —
 *    an order without the code may have come from elsewhere, so it is never counted as the campaign's.
 * Cancelled / refunded / deleted orders are excluded from revenue. Everything is scoped to the customer.
 */

export const NOT_COUNTED = ["canceled", "cancelled", "refunded", "restored", "deleted"];
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

export type OrderRow = {
  order_id: string;
  status: string | null;
  total: number | null;
  currency: string | null;
  coupon: string | null;
  items: string;
  ordered_at: number;
  discount: number | null;
  shipping: number | null;
  tax: number | null;
  payment_method: string | null;
  customer_hash: string | null;
  city: string | null;
};
type Item = { product_id: string; name: string | null; qty: number; amount: number };
export type Product = { product_id: string; name: string | null; url: string | null; image_url: string | null; price: number | null; status: string | null; cost: number | null; cost_manual: number | null };

const parseItems = (raw: string): Item[] => {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** Unit cost for a product: the cost entered in HSN, else the platform's cost price, else a % of the selling price. */
function unitCost(p: Product | undefined, unitPrice: number, defaultPct: number | null): { cost: number; source: "manual" | "store" | "pct" } | null {
  if (p?.cost_manual != null) return { cost: p.cost_manual, source: "manual" };
  if (p?.cost != null) return { cost: p.cost, source: "store" };
  if (defaultPct != null && unitPrice > 0) return { cost: (unitPrice * defaultPct) / 100, source: "pct" };
  return null;
}

/**
 * Money for a set of counted orders. Net sales = order total − tax − shipping (shipping passes to the carrier, tax to
 * the state). Profit = net sales − product cost, only over orders whose every item has a known cost.
 */
export function summarize(orders: OrderRow[], productById: Map<string, Product>, defaultPct: number | null) {
  let revenue = 0, net = 0, discount = 0, shipping = 0, tax = 0, units = 0;
  let costed = 0, costedNet = 0, cogs = 0;
  for (const o of orders) {
    const total = o.total ?? 0;
    const n = total - (o.tax ?? 0) - (o.shipping ?? 0);
    revenue += total;
    net += n;
    discount += o.discount ?? 0;
    shipping += o.shipping ?? 0;
    tax += o.tax ?? 0;
    const items = parseItems(o.items);
    let orderCost = 0;
    let known = items.length > 0;
    for (const i of items) {
      const qty = i.qty || 1;
      units += qty;
      const c = unitCost(productById.get(i.product_id), (i.amount || 0) / qty, defaultPct);
      if (c) orderCost += c.cost * qty;
      else known = false;
    }
    if (known) {
      costed++;
      costedNet += n;
      cogs += orderCost;
    }
  }
  const profit = costed ? costedNet - cogs : null;
  return {
    orders: orders.length,
    revenue,
    net,
    aov: orders.length ? revenue / orders.length : 0,
    discount,
    shipping,
    tax,
    units,
    profit,
    margin: profit !== null && costedNet > 0 ? profit / costedNet : null,
    profit_orders: costed,
  };
}

const countBy = <T,>(rows: T[], key: (r: T) => string | null, value: (r: T) => number = () => 0) => {
  const m = new Map<string, { key: string; orders: number; revenue: number }>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const x = m.get(k) ?? { key: k, orders: 0, revenue: 0 };
    x.orders++;
    x.revenue += value(r);
    m.set(k, x);
  }
  return [...m.values()].sort((a, b) => b.orders - a.orders || b.revenue - a.revenue);
};

export async function storeAnalytics(db: D1Database, t: number, f: { from: number; to: number; tzOffsetMin: number }) {
  const store = await first<{ id: number; name: string | null; domain: string | null; status: string; products_synced_at: number | null; connected_at: number; default_cost_pct: number | null }>(
    db,
    "SELECT id, name, domain, status, products_synced_at, connected_at, default_cost_pct FROM stores WHERE tenant_id = ? AND platform = 'salla' AND status != 'disconnected' ORDER BY id DESC LIMIT 1",
    t,
  );
  if (!store) return { store: null };
  // The period plus the same length before it, for the comparison.
  const span = Math.max(DAY, f.to - f.from);
  const prevFrom = f.from - span;
  const all_ = await all<OrderRow>(
    db,
    `SELECT order_id, status, total, currency, coupon, items, ordered_at, discount, shipping, tax, payment_method, customer_hash, city FROM store_orders
      WHERE store_id = ? AND deleted = 0 AND ordered_at >= ? AND ordered_at < ? ORDER BY ordered_at LIMIT 40000`,
    store.id,
    prevFrom,
    f.to,
  );
  const isCounted = (o: OrderRow) => !NOT_COUNTED.includes((o.status ?? "").toLowerCase());
  const orders = all_.filter((o) => o.ordered_at >= f.from);
  const counted = orders.filter(isCounted);
  const prevCounted = all_.filter((o) => o.ordered_at < f.from && isCounted(o));
  const currency = counted.find((o) => o.currency)?.currency ?? "SAR";

  const products = await all<Product>(
    db,
    "SELECT product_id, name, url, image_url, price, status, cost, cost_manual FROM store_products WHERE store_id = ?",
    store.id,
  );
  const productById = new Map(products.map((p) => [p.product_id, p]));
  const productByUrl = new Map(products.map((p) => [normalizeUrl(p.url), p]).filter(([k]) => k) as Array<[string, Product]>);
  const now = summarize(counted, productById, store.default_cost_pct);
  const prev = summarize(prevCounted, productById, store.default_cost_pct);

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

  const coupons = countBy(counted, (o) => o.coupon, (o) => o.total ?? 0);
  const ordersByCode = new Map<string, OrderRow[]>();
  for (const o of counted) if (o.coupon) ordersByCode.set(o.coupon, [...(ordersByCode.get(o.coupon) ?? []), o]);
  const byCoupon = new Map(coupons.map((c) => [c.key, c]));
  const campaignRows = campaigns
    .map((c) => {
      const code = c.store_coupon?.trim().toUpperCase() || null;
      const fromCode = code ? byCoupon.get(code) ?? { orders: 0, revenue: 0 } : null;
      const product = productByUrl.get(normalizeUrl(c.final_url) ?? "") ?? null;
      const cl = clicks.find((x) => x.campaign_id === c.id);
      const money = code ? summarize(ordersByCode.get(code) ?? [], productById, store.default_cost_pct) : null;
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        coupon: code,
        product: product ? { id: product.product_id, name: product.name, image_url: product.image_url } : null,
        profit: money?.profit ?? null,
        shared_coupon: code ? campaigns.filter((x) => x.id !== c.id && x.store_coupon?.trim().toUpperCase() === code).length > 0 : false,
        delivered: delivered.find((x) => x.campaign_id === c.id)?.people ?? 0,
        clicks: cl?.clicks ?? 0,
        clickers: cl?.people ?? 0,
        orders: fromCode?.orders ?? null,
        revenue: fromCode?.revenue ?? null,
      };
    })
    // Linked to the store = has a discount code or links to one of the store's products (clicks alone do not count).
    .filter((c) => c.coupon || c.product);
  const linkedIds = new Set(campaignRows.map((c) => c.id));
  const unlinked = campaigns.filter((c) => !linkedIds.has(c.id) && ["active", "paused"].includes(c.status)).slice(0, 20).map((c) => ({ id: c.id, name: c.name, status: c.status }));
  const attributedCodes = new Set(campaignRows.map((c) => c.coupon).filter(Boolean));
  const attributed = counted.filter((o) => o.coupon && attributedCodes.has(o.coupon));
  const campaignByCode = new Map(campaignRows.filter((c) => c.coupon).map((c) => [c.coupon!, { id: c.id, name: c.name }]));

  // Products: units / orders / revenue / profit from order items, plus the campaigns that link to each product.
  const perProduct = new Map<string, { units: number; orders: number; revenue: number; cost: number; costKnown: boolean; name: string | null }>();
  for (const o of counted) {
    const seen = new Set<string>();
    for (const i of parseItems(o.items)) {
      const qty = i.qty || 1;
      const x = perProduct.get(i.product_id) ?? { units: 0, orders: 0, revenue: 0, cost: 0, costKnown: true, name: i.name };
      x.units += qty;
      x.revenue += i.amount || 0;
      const c = unitCost(productById.get(i.product_id), (i.amount || 0) / qty, store.default_cost_pct);
      if (c) x.cost += c.cost * qty;
      else x.costKnown = false;
      if (!seen.has(i.product_id)) x.orders++;
      seen.add(i.product_id);
      perProduct.set(i.product_id, x);
    }
  }
  const productRows = [...perProduct.entries()]
    .map(([id, x]) => {
      const p = productById.get(id);
      const linked = campaignRows.filter((c) => c.product?.id === id);
      return {
        id,
        name: p?.name ?? x.name,
        url: p?.url ?? null,
        image_url: p?.image_url ?? null,
        units: x.units,
        orders: x.orders,
        revenue: x.revenue || null,
        profit: x.costKnown && x.revenue ? x.revenue - x.cost : null,
        campaigns: linked.map((c) => ({ id: c.id, name: c.name })),
        clicks: linked.reduce((a, c) => a + c.clicks, 0),
      };
    })
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 100);

  // Customers: new = their first order (since the store was connected) falls in the period.
  const hashes = [...new Set(counted.map((o) => o.customer_hash).filter(Boolean))] as string[];
  let newCustomers = 0;
  if (hashes.length) {
    const firsts = await all<{ customer_hash: string; first_at: number }>(
      db,
      `SELECT customer_hash, MIN(ordered_at) AS first_at FROM store_orders WHERE store_id = ? AND deleted = 0 AND customer_hash IS NOT NULL
        AND COALESCE(status, '') NOT IN (${NOT_COUNTED.map(() => "?").join(",")}) GROUP BY customer_hash`,
      store.id,
      ...NOT_COUNTED,
    );
    const set = new Set(hashes);
    newCustomers = firsts.filter((r) => set.has(r.customer_hash) && r.first_at >= f.from).length;
  }
  const ordersPerCustomer = new Map<string, number>();
  for (const o of counted) if (o.customer_hash) ordersPerCustomer.set(o.customer_hash, (ordersPerCustomer.get(o.customer_hash) ?? 0) + 1);

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
  const costs = {
    default_pct: store.default_cost_pct,
    products: products.filter((p) => (p.status ?? "") !== "deleted").length,
    with_cost: products.filter((p) => (p.status ?? "") !== "deleted" && (p.cost_manual != null || p.cost != null)).length,
  };
  const { default_cost_pct: _d, ...storeInfo } = store;
  return {
    store: { ...storeInfo, products: products.length },
    totals: {
      ...now,
      currency,
      excluded: orders.length - counted.length,
      attributed_orders: attributed.length,
      attributed_revenue: attributed.reduce((a, o) => a + (o.total ?? 0), 0),
    },
    previous: { orders: prev.orders, revenue: prev.revenue, aov: prev.aov, profit: prev.profit, net: prev.net },
    customers: {
      known: hashes.length,
      new: newCustomers,
      returning: hashes.length - newCustomers,
      repeat_in_period: [...ordersPerCustomer.values()].filter((n) => n > 1).length,
    },
    costs,
    payment_methods: countBy(counted, (o) => o.payment_method, (o) => o.total ?? 0).slice(0, 8),
    cities: countBy(counted, (o) => o.city, (o) => o.total ?? 0).slice(0, 8),
    statuses: countBy(orders, (o) => (o.status ?? "").toLowerCase() || null).slice(0, 10),
    coupons: coupons.slice(0, 15).map((c) => ({ code: c.key, orders: c.orders, revenue: c.revenue, campaign: campaignByCode.get(c.key) ?? null })),
    campaigns: campaignRows.sort((a, b) => (b.orders ?? -1) - (a.orders ?? -1) || b.clicks - a.clicks),
    unlinked,
    products: productRows,
    series: Array.from({ length: Math.max(0, Math.min(400, lastDay - firstDay + 1)) }, (_, i) => ({ day: firstDay + i, ...(series.get(firstDay + i) ?? { orders: 0, revenue: 0 }) })),
  };
}

/** Funnel counts of one campaign in a period: people who triggered it, got the content, clicked the link. */
async function campaignFunnel(db: D1Database, ids: number[], from: number, to: number) {
  if (!ids.length) return new Map<number, { triggered: number; delivered: number; clickers: number; clicks: number }>();
  const q = ids.map(() => "?").join(",");
  const [trig, del, clk] = await Promise.all([
    all<{ campaign_id: number; n: number }>(db, `SELECT campaign_id, COUNT(DISTINCT participant_id) AS n FROM conversation_flows WHERE campaign_id IN (${q}) AND is_demo = 0 AND created_at >= ? AND created_at < ? GROUP BY campaign_id`, ...ids, from, to),
    all<{ campaign_id: number; n: number }>(db, `SELECT campaign_id, COUNT(DISTINCT participant_id) AS n FROM conversation_flows WHERE campaign_id IN (${q}) AND is_demo = 0 AND state = 'content_sent' AND content_delivered_at >= ? AND content_delivered_at < ? GROUP BY campaign_id`, ...ids, from, to),
    all<{ campaign_id: number; n: number; clicks: number }>(db, `SELECT f.campaign_id, COUNT(DISTINCT f.participant_id) AS n, COUNT(*) AS clicks FROM link_clicks k JOIN conversation_flows f ON f.id = k.flow_id WHERE f.campaign_id IN (${q}) AND f.is_demo = 0 AND k.clicked_at >= ? AND k.clicked_at < ? GROUP BY f.campaign_id`, ...ids, from, to),
  ]);
  const m = new Map<number, { triggered: number; delivered: number; clickers: number; clicks: number }>();
  for (const id of ids) {
    const c = clk.find((x) => x.campaign_id === id);
    m.set(id, { triggered: trig.find((x) => x.campaign_id === id)?.n ?? 0, delivered: del.find((x) => x.campaign_id === id)?.n ?? 0, clickers: c?.n ?? 0, clicks: c?.clicks ?? 0 });
  }
  return m;
}

/**
 * One campaign in the store: its sales funnel (triggered → got the content → clicked → ordered with its code), money,
 * daily orders and its orders (no shopper data), compared with the averages of the customer's other coded campaigns.
 */
export async function storeCampaignDetail(db: D1Database, t: number, campaignId: number, f: { from: number; to: number; tzOffsetMin: number }) {
  const c = await first<{ id: number; name: string; status: string; type: string; store_coupon: string | null; final_url: string | null }>(
    db,
    "SELECT id, name, status, type, store_coupon, final_url FROM campaigns WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
    campaignId,
    t,
  );
  if (!c) return null;
  const store = await first<{ id: number; default_cost_pct: number | null }>(
    db,
    "SELECT id, default_cost_pct FROM stores WHERE tenant_id = ? AND platform = 'salla' AND status != 'disconnected' ORDER BY id DESC LIMIT 1",
    t,
  );
  if (!store) return { campaign: c, store: null };
  const code = c.store_coupon?.trim().toUpperCase() || null;
  const products = await all<Product>(db, "SELECT product_id, name, url, image_url, price, status, cost, cost_manual FROM store_products WHERE store_id = ?", store.id);
  const productById = new Map(products.map((p) => [p.product_id, p]));
  const product = products.find((p) => p.url && normalizeUrl(p.url) === normalizeUrl(c.final_url)) ?? null;
  const all_ = await all<OrderRow & { reference: string | null }>(
    db,
    `SELECT order_id, reference, status, total, currency, coupon, items, ordered_at, discount, shipping, tax, payment_method, customer_hash, city FROM store_orders
      WHERE store_id = ? AND deleted = 0 AND ordered_at >= ? AND ordered_at < ? ORDER BY ordered_at DESC LIMIT 20000`,
    store.id,
    f.from,
    f.to,
  );
  const isCounted = (o: OrderRow) => !NOT_COUNTED.includes((o.status ?? "").toLowerCase());
  const mine = code ? all_.filter((o) => o.coupon === code) : [];
  const counted = mine.filter(isCounted);
  const money = summarize(counted, productById, store.default_cost_pct);

  // Averages over the customer's campaigns that have a discount code (the fair comparison for this one).
  const coded = await all<{ id: number; store_coupon: string }>(db, "SELECT id, store_coupon FROM campaigns WHERE tenant_id = ? AND deleted_at IS NULL AND COALESCE(store_coupon, '') != ''", t);
  const funnels = await campaignFunnel(db, [...new Set([c.id, ...coded.map((x) => x.id)])], f.from, f.to);
  const fn = funnels.get(c.id)!;
  let sDel = 0, sClk = 0, sOrd = 0;
  const countedAll = all_.filter(isCounted);
  for (const x of coded) {
    const xf = funnels.get(x.id)!;
    sDel += xf.delivered;
    sClk += xf.clickers;
    sOrd += countedAll.filter((o) => o.coupon === x.store_coupon.trim().toUpperCase()).length;
  }
  const storeAov = countedAll.length ? countedAll.reduce((a, o) => a + (o.total ?? 0), 0) / countedAll.length : null;

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
  const others = code ? coded.filter((x) => x.id !== c.id && x.store_coupon.trim().toUpperCase() === code).length : 0;
  return {
    campaign: { ...c, coupon: code, shared_coupon: others > 0 },
    store: { id: store.id },
    product: product ? { id: product.product_id, name: product.name, image_url: product.image_url, url: product.url, price: product.price } : null,
    funnel: { ...fn, orders: code ? counted.length : null },
    totals: { ...money, currency: counted.find((o) => o.currency)?.currency ?? "SAR", excluded: mine.length - counted.length },
    averages: {
      click_rate: sDel ? sClk / sDel : null,
      order_rate: sClk ? sOrd / sClk : null,
      aov: storeAov,
      campaigns: coded.length,
    },
    orders: mine.slice(0, 50).map((o) => ({
      reference: o.reference ?? o.order_id,
      total: o.total,
      status: o.status,
      ordered_at: o.ordered_at,
      units: parseItems(o.items).reduce((a, i) => a + (i.qty || 1), 0),
      counted: isCounted(o),
    })),
    series: Array.from({ length: Math.max(0, Math.min(400, lastDay - firstDay + 1)) }, (_, i) => ({ day: firstDay + i, ...(series.get(firstDay + i) ?? { orders: 0, revenue: 0 }) })),
  };
}

/** Products with their unit cost, for the cost editor. */
export async function storeProductCosts(db: D1Database, t: number) {
  return all(
    db,
    `SELECT p.product_id, p.name, p.image_url, p.price, p.cost, p.cost_manual FROM store_products p JOIN stores s ON s.id = p.store_id
      WHERE s.tenant_id = ? AND s.status != 'disconnected' AND COALESCE(p.status, '') != 'deleted' ORDER BY p.name LIMIT 1000`,
    t,
  );
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
