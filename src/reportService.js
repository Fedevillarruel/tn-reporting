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

function getShareSecret() {
  return (
    process.env.TN_SHARE_TOKEN_SECRET ||
    process.env.TN_CLIENT_SECRET ||
    process.env.TN_APP_ID ||
    "tn-reporting-dev-secret"
  );
}

function passwordHash(password) {
  return crypto.createHash("sha256").update(String(password || "")).digest("hex");
}

function createShareToken({ name, password, filters }) {
  const payload = {
    v: 1,
    n: String(name || "Reporte"),
    f: filters || {},
    ph: passwordHash(password),
    iat: Date.now(),
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", getShareSecret()).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

function parseShareToken(token) {
  const [payloadB64, signature] = String(token || "").split(".");
  if (!payloadB64 || !signature) {
    return null;
  }

  const expected = crypto.createHmac("sha256", getShareSecret()).update(payloadB64).digest("base64url");
  if (signature !== expected) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}


function authenticateReport(slug, password) {
  const report = getReportBySlug(slug);

  if (!report || report.password !== password) {
    return null;
  }

  return report;
}

function authenticateReportToken(token, password) {
  const payload = parseShareToken(token);
  if (!payload) {
    return null;
  }

  if (String(payload.ph || "") !== passwordHash(password)) {
    return null;
  }

  return {
    slug: `token-${String(token).slice(0, 10)}`,
    name: String(payload.n || "Reporte"),
    filters: payload.f || {},
    updated_at: new Date().toISOString(),
  };
}

module.exports = {
  listSales,
  listCatalog,
  summarizeSales,
  createShareReport,
  createShareToken,
  getReportBySlug,
  authenticateReport,
  authenticateReportToken,
};
