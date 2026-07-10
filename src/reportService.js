const crypto = require("crypto");
const { filterSales, createReport, getReportBySlug } = require("./db");

function createSlug(size = 10) {
  return crypto.randomBytes(size).toString("base64url").slice(0, size);
}


function listSales(filters = {}) {
  return filterSales(filters).slice(0, 2000);
}

function listCatalog(filters = {}) {
  const rows = filterSales({ storeId: filters.storeId });
  const products = new Map();

  for (const row of rows) {
    const productKey = String(row.product_name || "Producto");
    const variantValue = String(row.variant_name || "Sin variante");

    if (!products.has(productKey)) {
      products.set(productKey, {
        productName: productKey,
        variants: new Set(),
      });
    }

    products.get(productKey).variants.add(variantValue);
  }

  return Array.from(products.values())
    .sort((left, right) => left.productName.localeCompare(right.productName))
    .map((item) => ({
      productName: item.productName,
      variants: Array.from(item.variants.values()).sort((a, b) => a.localeCompare(b)),
    }));
}

function summarizeSales(filters = {}) {
  const rows = filterSales(filters);
  const uniqueOrders = new Set(rows.map((row) => row.order_id));
  const byProductMap = new Map();

  let items = 0;
  let revenue = 0;

  for (const row of rows) {
    items += Number(row.quantity || 0);
    revenue += Number(row.total || 0);

    const current = byProductMap.get(row.product_name) || {
      product_name: row.product_name,
      quantity: 0,
      revenue: 0,
    };

    current.quantity += Number(row.quantity || 0);
    current.revenue += Number(row.total || 0);
    byProductMap.set(row.product_name, current);
  }

  const byProduct = Array.from(byProductMap.values())
    .sort((left, right) => right.revenue - left.revenue)
    .slice(0, 50)
    .map((item) => ({
      ...item,
      revenue: Number(item.revenue.toFixed(2)),
    }));

  return {
    orders: uniqueOrders.size,
    items,
    revenue: Number(revenue.toFixed(2)),
    byProduct,
  };
}

function createShareReport({ name, password, filters }) {
  const slug = createSlug(10);
  const now = new Date().toISOString();

  createReport({
    slug,
    name,
    password,
    filters: filters || {},
    created_at: now,
    updated_at: now,
  });

  return slug;
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
  listCatalog,
  summarizeSales,
  createShareReport,
  getReportBySlug,
  authenticateReport,
};
