const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const PDFDocument = require("pdfkit");

const { getSetting, setSetting, upsertSales } = require("./db");
const { fetchAllOrderLines } = require("./tiendanube");
const {
  listSales,
  summarizeSales,
  createShareReport,
  authenticateReport,
  getReportBySlug,
} = require("./reportService");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

const liveClients = new Map();

const dataDir = path.join(process.cwd(), "data");
if (!isServerless && !fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

function getConnectionConfig() {
  const envStoreId = process.env.TN_STORE_ID;
  const envToken = process.env.TN_ACCESS_TOKEN;

  return {
    storeId: getSetting("tn_store_id") || envStoreId,
    accessToken: getSetting("tn_access_token") || envToken,
  };
}


function publishLiveReport(slug) {
  const clients = liveClients.get(slug);
  if (!clients || !clients.size) {
    return;
  }

  const report = getReportBySlug(slug);
  if (!report) {
    return;
  }

  const payload = {
    report: {
      slug: report.slug,
      name: report.name,
      filters: report.filters,
      updatedAt: new Date().toISOString(),
    },
    summary: summarizeSales(report.filters),
  };

  for (const res of clients) {
    res.write(`event: reportUpdate\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get("/api/oauth/callback", (req, res) => {
  const code = String(req.query.code || "");
  const storeId = String(req.query.store_id || req.query.storeId || "");

  // This endpoint intentionally responds with a controlled status until full OAuth exchange is implemented.
  if (!code || !storeId) {
    return res.status(400).json({
      ok: false,
      error: "Faltan parametros OAuth",
      expected: ["code", "store_id"],
    });
  }

  return res.status(501).json({
    ok: false,
    error: "OAuth exchange pendiente de implementacion",
    received: { storeId },
  });
});

app.post("/api/privacy/store-redact", (_req, res) => {
  return res.status(202).json({ ok: true });
});

app.post("/api/privacy/customers-redact", (_req, res) => {
  return res.status(202).json({ ok: true });
});

app.post("/api/privacy/customers-data-request", (_req, res) => {
  return res.status(202).json({ ok: true });
});

app.get("/api/connection", (_req, res) => {
  const { storeId, accessToken } = getConnectionConfig();
  res.json({
    connected: Boolean(storeId && accessToken),
    storeId: storeId || "",
  });
});

app.post("/api/connection", (req, res) => {
  const { storeId, accessToken } = req.body || {};

  if (!storeId || !accessToken) {
    return res.status(400).json({ error: "storeId y accessToken son obligatorios" });
  }

  setSetting("tn_store_id", String(storeId));
  setSetting("tn_access_token", String(accessToken));

  return res.json({ ok: true });
});

app.post("/api/tiendanube/sync", async (_req, res) => {
  try {
    const { storeId, accessToken } = getConnectionConfig();

    if (!storeId || !accessToken) {
      return res.status(400).json({ error: "Configura storeId y accessToken antes de sincronizar" });
    }

    const lines = await fetchAllOrderLines({
      storeId,
      accessToken,
      maxPages: Number(process.env.TN_MAX_PAGES || 20),
    });

    upsertSales(lines);

    for (const slug of liveClients.keys()) {
      publishLiveReport(slug);
    }

    return res.json({
      ok: true,
      importedRows: lines.length,
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      error: "No se pudo sincronizar con Tiendanube",
      detail: error.response?.data || error.message,
    });
  }
});

app.get("/api/sales", (req, res) => {
  const filters = {
    fromDate: req.query.fromDate,
    toDate: req.query.toDate,
    productName: req.query.productName,
  };

  const rows = listSales(filters);
  const summary = summarizeSales(filters);

  res.json({ rows, summary, filters });
});

app.post("/api/reports", (req, res) => {
  const { name, password, filters } = req.body || {};

  if (!name || !password) {
    return res.status(400).json({ error: "name y password son obligatorios" });
  }

  const slug = createShareReport({ name, password, filters: filters || {} });
  const baseUrl = `${req.protocol}://${req.get("host")}`;

  return res.json({
    ok: true,
    slug,
    shareUrl: `${baseUrl}/share.html?slug=${slug}`,
    pdfUrl: `${baseUrl}/api/reports/${slug}/pdf`,
  });
});

app.get("/api/reports/:slug", (req, res) => {
  const { slug } = req.params;
  const { password } = req.query;

  const report = authenticateReport(slug, String(password || ""));

  if (!report) {
    return res.status(401).json({ error: "Reporte no encontrado o clave incorrecta" });
  }

  return res.json({
    report: {
      slug: report.slug,
      name: report.name,
      filters: report.filters,
      updatedAt: report.updated_at,
    },
    summary: summarizeSales(report.filters),
  });
});

app.get("/api/reports/:slug/pdf", (req, res) => {
  const { slug } = req.params;
  const { password } = req.query;
  const report = authenticateReport(slug, String(password || ""));

  if (!report) {
    return res.status(401).json({ error: "Clave incorrecta" });
  }

  const summary = summarizeSales(report.filters);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename=report-${slug}.pdf`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  doc.fontSize(22).text(report.name);
  doc.moveDown(0.4);
  doc.fontSize(11).text(`Generado: ${new Date().toLocaleString()}`);
  doc.moveDown(0.8);

  doc.fontSize(14).text("Resumen");
  doc.moveDown(0.5);
  doc.fontSize(11).text(`Pedidos: ${summary.orders}`);
  doc.fontSize(11).text(`Items vendidos: ${summary.items}`);
  doc.fontSize(11).text(`Facturacion: $${summary.revenue.toFixed(2)}`);
  doc.moveDown(1);

  doc.fontSize(14).text("Top productos");
  doc.moveDown(0.6);
  for (const item of summary.byProduct.slice(0, 25)) {
    doc.fontSize(10).text(
      `${item.product_name} | Unidades: ${item.quantity} | Facturacion: $${Number(item.revenue).toFixed(2)}`
    );
  }

  doc.end();
});

app.get("/api/reports/:slug/stream", (req, res) => {
  const { slug } = req.params;
  const password = String(req.query.password || "");
  const report = authenticateReport(slug, password);

  if (!report) {
    return res.status(401).end();
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  if (!liveClients.has(slug)) {
    liveClients.set(slug, new Set());
  }

  const clients = liveClients.get(slug);
  clients.add(res);

  const initialPayload = {
    report: {
      slug: report.slug,
      name: report.name,
      filters: report.filters,
      updatedAt: report.updated_at,
    },
    summary: summarizeSales(report.filters),
  };

  res.write(`event: reportUpdate\n`);
  res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);

  req.on("close", () => {
    clients.delete(res);
    if (!clients.size) {
      liveClients.delete(slug);
    }
  });

  return undefined;
});

if (!isServerless) {
  setInterval(() => {
    for (const slug of liveClients.keys()) {
      publishLiveReport(slug);
    }
  }, 15000);
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`reporting-tn running on http://localhost:${PORT}`);
  });
}

module.exports = app;
