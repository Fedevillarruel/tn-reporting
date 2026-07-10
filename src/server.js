const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const PDFDocument = require("pdfkit");

const {
  getSetting,
  setSetting,
  upsertSales,
  upsertStore,
  listStores,
  getStoreById,
} = require("./db");
const { fetchAllOrderLines, exchangeOAuthCode } = require("./tiendanube");
const {
  listSales,
  listCatalog,
  summarizeSales,
  createShareReport,
  authenticateReport,
  getReportBySlug,
} = require("./reportService");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const AUTO_SYNC_MS = Number(process.env.TN_AUTO_SYNC_MS || 60000);

const liveClients = new Map();
const syncLocks = new Set();

const dataDir = path.join(process.cwd(), "data");
if (!isServerless && !fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

function parseCookies(req) {
  const header = String(req?.headers?.cookie || "");
  const cookies = {};
  if (!header) {
    return cookies;
  }

  for (const chunk of header.split(";")) {
    const [rawKey, ...rest] = chunk.trim().split("=");
    if (!rawKey) continue;
    cookies[rawKey] = decodeURIComponent(rest.join("=") || "");
  }
  return cookies;
}

function setAuthCookies(res, storeId, accessToken) {
  const common = "Path=/; Max-Age=2592000; SameSite=Lax; Secure; HttpOnly";
  res.append("Set-Cookie", `tn_store_id=${encodeURIComponent(String(storeId))}; ${common}`);
  res.append("Set-Cookie", `tn_access_token=${encodeURIComponent(String(accessToken))}; ${common}`);
}

function getConnectionConfig(req) {
  const cookies = parseCookies(req);
  const envStoreId = process.env.TN_STORE_ID;
  const envToken = process.env.TN_ACCESS_TOKEN;
  const activeStoreId =
    getSetting("tn_active_store_id") ||
    getSetting("tn_store_id") ||
    cookies.tn_store_id ||
    envStoreId;
  const storedToken = activeStoreId ? getSetting(`tn_store_${activeStoreId}_access_token`) : "";

  return {
    storeId: activeStoreId,
    accessToken: storedToken || getSetting("tn_access_token") || cookies.tn_access_token || envToken,
  };
}

function storePublicInfo(storeId) {
  const store = getStoreById(storeId);
  if (!store) {
    return null;
  }

  return {
    ...store,
    lastSyncAt: Number(getSetting(`tn_store_${storeId}_last_sync`) || 0) || null,
    hasSystemPassword: Boolean(getSetting(`tn_store_${storeId}_system_password`)),
  };
}

async function syncStoreSales({ storeId, accessToken, force = false }) {
  if (!storeId || !accessToken) {
    return { ok: false, reason: "missing_config" };
  }

  const syncKey = `tn_store_${storeId}_last_sync`;
  const lastSync = Number(getSetting(syncKey) || 0);
  const now = Date.now();

  if (!force && now - lastSync < AUTO_SYNC_MS) {
    return { ok: true, skipped: true, reason: "fresh" };
  }

  if (syncLocks.has(String(storeId))) {
    return { ok: true, skipped: true, reason: "in_progress" };
  }

  syncLocks.add(String(storeId));
  try {
    const lines = await fetchAllOrderLines({
      storeId,
      accessToken,
      maxPages: Number(process.env.TN_MAX_PAGES || 20),
    });

    upsertSales(lines);
    setSetting(syncKey, String(now));

    for (const slug of liveClients.keys()) {
      publishLiveReport(slug);
    }

    return {
      ok: true,
      skipped: false,
      importedRows: lines.length,
      syncedAt: new Date(now).toISOString(),
    };
  } finally {
    syncLocks.delete(String(storeId));
  }
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
  return (async () => {
    const code = String(req.query.code || "");
    const storeIdFromQuery = String(
      req.query.store_id || req.query.storeId || req.query.user_id || req.query.shop_id || ""
    );
    const appId = process.env.TN_APP_ID;
    const clientSecret = process.env.TN_CLIENT_SECRET;
    const appUrl = process.env.TN_APP_URL || `${req.protocol}://${req.get("host")}`;

    if (!code) {
      return res.status(400).json({
        ok: false,
        error: "Faltan parametros OAuth",
        expected: ["code"],
        receivedQueryKeys: Object.keys(req.query || {}),
      });
    }

    if (!appId || !clientSecret) {
      return res.status(500).json({
        ok: false,
        error: "Falta configuracion OAuth en variables de entorno",
        required: ["TN_APP_ID", "TN_CLIENT_SECRET"],
      });
    }

    try {
      const tokenResponse = await exchangeOAuthCode({
        code,
        clientId: appId,
        clientSecret,
      });

      const resolvedStoreId = String(storeIdFromQuery || tokenResponse.user_id || tokenResponse.store_id || "");

      if (!tokenResponse.access_token) {
        return res.status(502).json({
          ok: false,
          error: "Tiendanube no devolvio access_token",
          detail: tokenResponse,
        });
      }

      if (!resolvedStoreId) {
        return res.status(502).json({
          ok: false,
          error: "Tiendanube no devolvio identificador de tienda",
          detail: tokenResponse,
        });
      }

      setSetting(`tn_store_${resolvedStoreId}_access_token`, String(tokenResponse.access_token));
      setSetting("tn_active_store_id", String(resolvedStoreId));
      setSetting("tn_store_id", String(resolvedStoreId));
      setSetting("tn_access_token", String(tokenResponse.access_token));
      setAuthCookies(res, resolvedStoreId, tokenResponse.access_token);

      upsertStore({
        store_id: String(resolvedStoreId),
        name: String(tokenResponse.user_name || tokenResponse.store_name || `Tienda ${resolvedStoreId}`),
        linked_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });

      const installedUrl = `${appUrl}/?installed=1&store_id=${encodeURIComponent(resolvedStoreId)}`;
      return res.status(200).send(`
        <!doctype html>
        <html lang="es">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Instalacion completa</title>
            <style>
              body { font-family: sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px; }
              a { color: #0b6a73; }
            </style>
          </head>
          <body>
            <h1>App conectada con Tiendanube</h1>
            <p>Tienda vinculada: <strong>${htmlEscape(resolvedStoreId)}</strong></p>
            <p>Ya puedes volver al panel para sincronizar ventas y generar reportes.</p>
            <p><a href="${installedUrl}">Ir al panel</a></p>
          </body>
        </html>
      `);
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: "No se pudo completar OAuth con Tiendanube",
        detail: error.response?.data || error.message,
      });
    }
  })();
});

app.get("/api/oauth/install-url", (req, res) => {
  const rawDomain = String(req.query.storeDomain || "").trim().toLowerCase();
  const appId = process.env.TN_APP_ID;

  if (!appId) {
    return res.status(500).json({
      ok: false,
      error: "Falta TN_APP_ID en variables de entorno",
    });
  }

  if (!rawDomain) {
    return res.status(400).json({
      ok: false,
      error: "storeDomain es obligatorio",
    });
  }

  const normalized = rawDomain
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/\.mitiendanube\.com$/, "");

  if (!/^[a-z0-9-]+$/i.test(normalized)) {
    return res.status(400).json({
      ok: false,
      error: "storeDomain invalido",
      example: "fediniappdemo",
    });
  }

  const state = `reporting-${Date.now()}`;
  const authorizeUrl = `https://${normalized}.mitiendanube.com/admin/apps/${encodeURIComponent(
    appId
  )}/authorize?state=${encodeURIComponent(state)}`;

  return res.json({
    ok: true,
    storeDomain: normalized,
    authorizeUrl,
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

app.get("/api/stores", (req, res) => {
  const cookies = parseCookies(req);
  const cookieStoreId = String(cookies.tn_store_id || "");
  const activeStoreId = String(getSetting("tn_active_store_id") || cookieStoreId || "");
  const stores = listStores()
    .map((store) => storePublicInfo(store.store_id))
    .filter(Boolean)
    .map((store) => ({
      ...store,
      active: String(store.store_id) === activeStoreId,
    }));

  if (cookieStoreId && !stores.some((store) => String(store.store_id) === cookieStoreId)) {
    stores.push({
      store_id: cookieStoreId,
      name: `Tienda ${cookieStoreId}`,
      linked_at: null,
      created_at: null,
      updated_at: null,
      lastSyncAt: null,
      hasSystemPassword: false,
      active: String(activeStoreId) === cookieStoreId,
    });
  }

  return res.json({ stores, activeStoreId });
});

app.post("/api/stores/active", (req, res) => {
  const storeId = String(req.body?.storeId || "");
  const cookies = parseCookies(req);
  const exists = Boolean(getStoreById(storeId) || String(cookies.tn_store_id || "") === storeId);
  if (!storeId || !exists) {
    return res.status(404).json({ ok: false, error: "Tienda no encontrada" });
  }

  setSetting("tn_active_store_id", storeId);
  const token = getSetting(`tn_store_${storeId}_access_token`) || getSetting("tn_access_token") || cookies.tn_access_token || "";
  if (token) {
    setAuthCookies(res, storeId, token);
  }
  return res.json({ ok: true, storeId });
});

app.post("/api/stores/:storeId/password", (req, res) => {
  const storeId = String(req.params.storeId || "");
  const password = String(req.body?.password || "").trim();
  const cookies = parseCookies(req);

  const exists = Boolean(getStoreById(storeId) || String(cookies.tn_store_id || "") === storeId);
  if (!storeId || !exists) {
    return res.status(404).json({ ok: false, error: "Tienda no encontrada" });
  }

  if (!password) {
    return res.status(400).json({ ok: false, error: "Password requerida" });
  }

  setSetting(`tn_store_${storeId}_system_password`, password);
  return res.json({ ok: true });
});

app.get("/api/connection", (req, res) => {
  const { storeId, accessToken } = getConnectionConfig(req);
  res.json({
    connected: Boolean(storeId && accessToken),
    storeId: storeId || "",
    stores: listStores().map((store) => storePublicInfo(store.store_id)),
  });
});

app.post("/api/connection", (req, res) => {
  const { storeId, accessToken } = req.body || {};

  if (!storeId || !accessToken) {
    return res.status(400).json({ error: "storeId y accessToken son obligatorios" });
  }

  const resolvedStoreId = String(storeId);
  setSetting("tn_store_id", resolvedStoreId);
  setSetting("tn_access_token", String(accessToken));
  setSetting(`tn_store_${resolvedStoreId}_access_token`, String(accessToken));
  setSetting("tn_active_store_id", resolvedStoreId);
  setAuthCookies(res, resolvedStoreId, accessToken);
  upsertStore({
    store_id: resolvedStoreId,
    name: `Tienda ${resolvedStoreId}`,
    linked_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  });

  return res.json({ ok: true });
});

app.post("/api/tiendanube/sync", async (req, res) => {
  try {
    const { storeId, accessToken } = getConnectionConfig(req);

    if (!storeId || !accessToken) {
      return res.status(400).json({ error: "No hay tienda activa vinculada" });
    }

    const result = await syncStoreSales({ storeId, accessToken, force: true });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      error: "No se pudo sincronizar con Tiendanube",
      detail: error.response?.data || error.message,
    });
  }
});

app.get("/api/sales", (req, res) => {
  return (async () => {
    const { storeId, accessToken } = getConnectionConfig(req);
    if (!storeId || !accessToken) {
      return res.status(400).json({ ok: false, error: "No hay tienda activa vinculada" });
    }

    await syncStoreSales({ storeId, accessToken, force: false });

    const filters = {
      storeId,
      fromDate: req.query.fromDate,
      toDate: req.query.toDate,
      productName: req.query.productName,
      variantName: req.query.variantName,
    };

    const rows = listSales(filters);
    const summary = summarizeSales(filters);
    const catalog = listCatalog({ storeId });
    const systemPassword = getSetting(`tn_store_${storeId}_system_password`) || "";

    return res.json({ rows, summary, filters, catalog, storeId, systemPassword });
  })();
});

app.post("/api/reports", (req, res) => {
  return (async () => {
    const { storeId, accessToken } = getConnectionConfig(req);
    if (!storeId || !accessToken) {
      return res.status(400).json({ error: "No hay tienda activa vinculada" });
    }

    await syncStoreSales({ storeId, accessToken, force: false });

    const { name, password, filters } = req.body || {};

    if (!name || !password) {
      return res.status(400).json({ error: "name y password son obligatorios" });
    }

    const slug = createShareReport({
      name,
      password,
      filters: {
        ...(filters || {}),
        storeId,
      },
    });
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    return res.json({
      ok: true,
      slug,
      shareUrl: `${baseUrl}/share.html?slug=${slug}`,
      pdfUrl: `${baseUrl}/api/reports/${slug}/pdf`,
    });
  })();
});

app.get("/api/reports/:slug", (req, res) => {
  return (async () => {
    const { slug } = req.params;
    const { password } = req.query;

    const report = authenticateReport(slug, String(password || ""));

    if (!report) {
      return res.status(401).json({ error: "Reporte no encontrado o clave incorrecta" });
    }

    const storeAccessToken = getSetting(`tn_store_${report.filters.storeId}_access_token`) || "";
    if (report.filters.storeId && storeAccessToken) {
      await syncStoreSales({ storeId: report.filters.storeId, accessToken: storeAccessToken, force: false });
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
  })();
});

app.get("/api/reports/:slug/pdf", (req, res) => {
  return (async () => {
    const { slug } = req.params;
    const { password } = req.query;
    const report = authenticateReport(slug, String(password || ""));

    if (!report) {
      return res.status(401).json({ error: "Clave incorrecta" });
    }

    const storeAccessToken = getSetting(`tn_store_${report.filters.storeId}_access_token`) || "";
    if (report.filters.storeId && storeAccessToken) {
      await syncStoreSales({ storeId: report.filters.storeId, accessToken: storeAccessToken, force: false });
    }

    const summary = summarizeSales(report.filters);

    const formatMoney = (value) => `$${Number(value || 0).toFixed(2)}`;
    const metaDate = new Date().toLocaleString("es-AR");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=report-${slug}.pdf`);

    const doc = new PDFDocument({ margin: 42, size: "A4" });
    doc.pipe(res);

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const x = 42;
    const contentW = pageW - x * 2;

    doc.rect(0, 0, pageW, pageH).fill("#F3EFE7");

    // Header block.
    doc.rect(0, 0, pageW, 118).fill("#14324A");
    doc.rect(0, 110, pageW, 8).fill("#D17A22");
    doc.fillColor("#F8F3E8").fontSize(11).font("Helvetica-Bold").text("REPORTE DE VENTAS", x, 26);
    doc.fillColor("#FFFFFF").fontSize(24).font("Helvetica-Bold").text(String(report.name || "Reporte"), x, 42, {
      width: contentW,
      ellipsis: true,
    });
    doc
      .fillColor("#D5DEE6")
      .fontSize(10)
      .font("Helvetica")
      .text(`Tienda: ${report.filters.storeId || "N/A"}`, x, 88)
      .text(`Generado: ${metaDate}`, x + 210, 88);

    doc.y = 140;
    doc.fillColor("#1A1A1A").font("Helvetica-Bold").fontSize(15).text("Resumen");

    const cardsY = doc.y + 10;
    const gap = 10;
    const cardW = (contentW - gap * 2) / 3;
    const cardH = 74;
    const cards = [
      { label: "Pedidos", value: String(summary.orders), tone: "#E7F0F8" },
      { label: "Items", value: String(summary.items), tone: "#F1EADC" },
      { label: "Facturacion", value: formatMoney(summary.revenue), tone: "#EAE8F5" },
    ];

    cards.forEach((card, index) => {
      const cardX = x + (cardW + gap) * index;
      doc.roundedRect(cardX, cardsY, cardW, cardH, 10).fillAndStroke(card.tone, "#C9C1B3");
      doc.fillColor("#5B5248").font("Helvetica").fontSize(10).text(card.label, cardX + 12, cardsY + 12);
      doc.fillColor("#1D1D1D").font("Helvetica-Bold").fontSize(22).text(card.value, cardX + 12, cardsY + 30, {
        width: cardW - 24,
        ellipsis: true,
      });
    });

    let tableY = cardsY + cardH + 26;
    doc.fillColor("#1A1A1A").font("Helvetica-Bold").fontSize(15).text("Top productos", x, tableY);
    tableY += 24;

    const colProduct = 320;
    const colQty = 70;
    const colRevenue = contentW - colProduct - colQty;

    function drawTableHeader(y) {
      doc.rect(x, y, contentW, 24).fill("#EFE7D7");
      doc
        .fillColor("#3D372F")
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("Producto", x + 10, y + 8, { width: colProduct - 14 })
        .text("Unidades", x + colProduct + 2, y + 8, { width: colQty - 8, align: "right" })
        .text("Facturacion", x + colProduct + colQty + 2, y + 8, { width: colRevenue - 12, align: "right" });
      return y + 24;
    }

    tableY = drawTableHeader(tableY);

    const rows = summary.byProduct.slice(0, 20);
    if (!rows.length) {
      doc
        .fillColor("#5B5248")
        .font("Helvetica")
        .fontSize(11)
        .text("No hay datos para los filtros actuales.", x, tableY + 10);
    }

    rows.forEach((item, index) => {
      const product = String(item.product_name || "-");
      const qty = String(item.quantity || 0);
      const revenue = formatMoney(item.revenue);
      const textH = doc.heightOfString(product, {
        width: colProduct - 16,
        align: "left",
      });
      const rowH = Math.max(24, textH + 10);

      if (tableY + rowH > pageH - 54) {
        doc.addPage();
        doc.rect(0, 0, pageW, pageH).fill("#F3EFE7");
        tableY = 42;
        tableY = drawTableHeader(tableY);
      }

      if (index % 2 === 0) {
        doc.rect(x, tableY, contentW, rowH).fill("#FBF8F1");
      }

      doc
        .fillColor("#222")
        .font("Helvetica")
        .fontSize(10)
        .text(product, x + 10, tableY + 5, { width: colProduct - 16, lineGap: 1 })
        .text(qty, x + colProduct + 2, tableY + 8, { width: colQty - 8, align: "right" })
        .text(revenue, x + colProduct + colQty + 2, tableY + 8, { width: colRevenue - 12, align: "right" });

      doc.moveTo(x, tableY + rowH).lineTo(x + contentW, tableY + rowH).stroke("#D6CEBF");
      tableY += rowH;
    });

    doc
      .fillColor("#7A7165")
      .font("Helvetica")
      .fontSize(9)
      .text("Reporte generado automaticamente por TN Reporting", x, pageH - 26, {
        width: contentW,
        align: "right",
      });

    doc.end();
  })();
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
  setInterval(async () => {
    const stores = listStores();
    for (const store of stores) {
      const accessToken = getSetting(`tn_store_${store.store_id}_access_token`) || "";
      if (accessToken) {
        await syncStoreSales({ storeId: store.store_id, accessToken, force: false });
      }
    }

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
