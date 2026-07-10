const crypto = require("crypto");
const { db } = require("./db");

function createSlug(size = 10) {
  return crypto.randomBytes(size).toString("base64url").slice(0, size);
}

function buildSalesWhere(filters = {}) {
  const where = [];
  const args = [];

  if (filters.fromDate) {
    where.push("datetime(created_at) >= datetime(?)");
    args.push(filters.fromDate);
  }

  if (filters.toDate) {
    where.push("datetime(created_at) <= datetime(?)");
    args.push(filters.toDate);
  }

  if (filters.productName) {
    where.push("lower(product_name) LIKE lower(?)");
    args.push(`%${filters.productName}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return { whereSql, args };
}

function listSales(filters = {}) {
  const { whereSql, args } = buildSalesWhere(filters);

  const rows = db
    .prepare(
      `
      SELECT
        order_id,
        order_number,
        created_at,
        customer_name,
        product_id,
        product_name,
        variant_name,
        quantity,
        price,
        total
      FROM sales
      ${whereSql}
      ORDER BY datetime(created_at) DESC
      LIMIT 2000
    `
    )
    .all(...args);

  return rows;
}

function summarizeSales(filters = {}) {
  const { whereSql, args } = buildSalesWhere(filters);

  const totals = db
    .prepare(
      `
      SELECT
        COUNT(DISTINCT order_id) AS orders,
        SUM(quantity) AS items,
        SUM(total) AS revenue
      FROM sales
      ${whereSql}
    `
    )
    .get(...args);

  const byProduct = db
    .prepare(
      `
      SELECT
        product_name,
        SUM(quantity) AS quantity,
        SUM(total) AS revenue
      FROM sales
      ${whereSql}
      GROUP BY product_name
      ORDER BY revenue DESC
      LIMIT 50
    `
    )
    .all(...args);

  return {
    orders: totals.orders || 0,
    items: totals.items || 0,
    revenue: Number((totals.revenue || 0).toFixed(2)),
    byProduct,
  };
}

function createShareReport({ name, password, filters }) {
  const slug = createSlug(10);
  const now = new Date().toISOString();

  db.prepare(
    `
    INSERT INTO reports(slug, name, password, filters_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `
  ).run(slug, name, password, JSON.stringify(filters || {}), now, now);

  return slug;
}

function getReportBySlug(slug) {
  const row = db.prepare("SELECT * FROM reports WHERE slug = ?").get(slug);

  if (!row) {
    return null;
  }

  return {
    ...row,
    filters: JSON.parse(row.filters_json || "{}"),
  };
}

function authenticateReport(slug, password) {
  const report = getReportBySlug(slug);

  if (!report || report.password !== password) {
    return null;
  }

  return report;
}

module.exports = {
  listSales,
  summarizeSales,
  createShareReport,
  getReportBySlug,
  authenticateReport,
};
