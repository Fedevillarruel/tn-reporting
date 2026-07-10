const $ = (selector) => document.querySelector(selector);

const syncStatus = $("#syncStatus");
const applyFiltersBtn = $("#applyFilters");
const shareForm = $("#share-form");
const storeSelect = $("#storeSelect");
const saveSystemPasswordBtn = $("#saveSystemPassword");
const openStoreLinkBtn = $("#openStoreLink");
const storeManager = $("#storeManager");
const storeSummary = $("#storeSummary");
const activeStoreTitle = $("#activeStoreTitle");
const changeAccountBtn = $("#changeAccount");

let currentFilters = {
  fromDate: "",
  toDate: "",
  productName: "",
  variantName: "",
};

let catalogCache = [];

function setStatus(text) {
  syncStatus.textContent = text;
}

function getFilters() {
  return {
    fromDate: $("#fromDate").value || "",
    toDate: $("#toDate").value || "",
    productName: $("#productName").value.trim(),
    variantName: $("#variantName").value.trim(),
  };
}

function renderSummary(summary) {
  $("#kpiOrders").textContent = summary.orders;
  $("#kpiItems").textContent = summary.items;
  $("#kpiRevenue").textContent = `$${Number(summary.revenue).toFixed(2)}`;
}

function renderRows(rows) {
  const tbody = $("#salesTable tbody");
  tbody.innerHTML = "";

  for (const row of rows.slice(0, 500)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(row.created_at).toLocaleString()}</td>
      <td>#${row.order_number}</td>
      <td>${row.customer_name}</td>
      <td>${row.product_name} / ${row.variant_name || "Sin variante"}</td>
      <td>${row.quantity}</td>
      <td>$${Number(row.total).toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderProductDropdown(catalog, selectedProduct = "", selectedVariant = "") {
  const productSelect = $("#productName");

  catalogCache = catalog || [];
  productSelect.innerHTML = '<option value="">Todos</option>';
  for (const item of catalogCache) {
    const option = document.createElement("option");
    option.value = item.productName;
    option.textContent = item.productName;
    productSelect.appendChild(option);
  }

  if (selectedProduct) {
    productSelect.value = selectedProduct;
  }

  renderVariantDropdown(selectedProduct, selectedVariant);
}

function renderVariantDropdown(selectedProduct, selectedVariant = "") {
  const variantSelect = $("#variantName");
  variantSelect.innerHTML = '<option value="">Todas</option>';

  let variants = [];

  if (!selectedProduct) {
    const all = new Set();
    for (const product of catalogCache) {
      for (const variant of product.variants || []) {
        all.add(variant);
      }
    }
    variants = Array.from(all.values()).sort((a, b) => a.localeCompare(b));
  } else {
    const product = catalogCache.find((item) => item.productName === selectedProduct);
    variants = product ? (product.variants || []).slice().sort((a, b) => a.localeCompare(b)) : [];
  }

  for (const variant of variants) {
    const option = document.createElement("option");
    option.value = variant;
    option.textContent = variant;
    variantSelect.appendChild(option);
  }

  if (selectedVariant) {
    variantSelect.value = selectedVariant;
  }
}

async function copyToClipboard(value) {
  if (!value) return;
  await navigator.clipboard.writeText(value);
}

async function nativeShare(url) {
  if (!url) return;
  if (navigator.share) {
    await navigator.share({ title: "Reporte TN", url });
    return;
  }

  await copyToClipboard(url);
  alert("No hay share nativo en este navegador. Se copio el link.");
}

async function loadStores() {
  const response = await fetch("/api/stores");
  if (!response.ok) {
    setStatus("No hay tiendas vinculadas aun. Vincula desde Tiendanube Partners.");
    return;
  }

  const data = await response.json();
  const stores = data.stores || [];
  const activeStoreId = String(data.activeStoreId || "");

  storeSelect.innerHTML = "";
  if (!stores.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Sin tiendas vinculadas";
    storeSelect.appendChild(option);
    storeManager.hidden = false;
    storeSummary.hidden = true;
    setStatus("Vincula una tienda para comenzar");
    return;
  }

  for (const store of stores) {
    const option = document.createElement("option");
    option.value = String(store.store_id);
    option.textContent = `${store.name} (${store.store_id})`;
    if (store.active) {
      option.selected = true;
    }
    storeSelect.appendChild(option);
  }

  const activeStore = stores.find((store) => String(store.store_id) === activeStoreId) || stores[0];
  if (activeStore) {
    activeStoreTitle.textContent = `Tienda vinculada: ${activeStore.name} (${activeStore.store_id})`;
  }

  const params = new URLSearchParams(window.location.search);
  const forceManager = params.get("manage") === "1";
  storeManager.hidden = !forceManager;
  storeSummary.hidden = forceManager;

  setStatus("Sincronizacion automatica activa");
}

async function selectStore(storeId) {
  const response = await fetch("/api/stores/active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storeId }),
  });

  if (!response.ok) {
    setStatus("No se pudo cambiar la tienda activa");
    return false;
  }

  return true;
}

async function saveSystemPassword() {
  const storeId = storeSelect.value;
  const password = $("#systemPassword").value.trim();

  if (!storeId || !password) {
    setStatus("Selecciona tienda y define clave");
    return;
  }

  const response = await fetch(`/api/stores/${encodeURIComponent(storeId)}/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

  if (!response.ok) {
    setStatus("No se pudo guardar la clave del sistema");
    return;
  }

  setStatus("Clave del sistema guardada");
}

async function loadSales() {
  const params = new URLSearchParams();
  if (currentFilters.fromDate) params.set("fromDate", currentFilters.fromDate);
  if (currentFilters.toDate) params.set("toDate", currentFilters.toDate);
  if (currentFilters.productName) params.set("productName", currentFilters.productName);
  if (currentFilters.variantName) params.set("variantName", currentFilters.variantName);

  setStatus("Sincronizando automaticamente...");
  const response = await fetch(`/api/sales?${params.toString()}`);
  const data = await response.json();

  if (!response.ok) {
    setStatus(data.error || "No se pudieron cargar ventas");
    return;
  }

  renderSummary(data.summary);
  renderRows(data.rows);
  renderProductDropdown(
    data.catalog || [],
    data.filters?.productName || currentFilters.productName || "",
    data.filters?.variantName || currentFilters.variantName || ""
  );

  if (data.systemPassword && !$("#reportPassword").value) {
    $("#reportPassword").value = data.systemPassword;
  }

  setStatus("Datos actualizados automaticamente");
}

applyFiltersBtn.addEventListener("click", async () => {
  currentFilters = getFilters();
  await loadSales();
});

$("#productName").addEventListener("change", () => {
  renderVariantDropdown($("#productName").value, "");
});

storeSelect.addEventListener("change", async () => {
  const ok = await selectStore(storeSelect.value);
  if (ok) {
    currentFilters = {
      fromDate: "",
      toDate: "",
      productName: "",
      variantName: "",
    };
    $("#fromDate").value = "";
    $("#toDate").value = "";
    await loadSales();
  }
});

changeAccountBtn.addEventListener("click", () => {
  storeSummary.hidden = true;
  storeManager.hidden = false;
});

saveSystemPasswordBtn.addEventListener("click", saveSystemPassword);

openStoreLinkBtn.addEventListener("click", async () => {
  const storeDomain = $("#linkStoreDomain").value.trim();
  if (!storeDomain) {
    setStatus("Escribe el dominio corto de la tienda para vincular");
    return;
  }

  const response = await fetch(
    `/api/oauth/install-url?storeDomain=${encodeURIComponent(storeDomain)}`
  );
  const data = await response.json();

  if (!response.ok) {
    setStatus(data.error || "No se pudo generar el link de vinculacion");
    return;
  }

  // Use top-level navigation so it reuses the current Tiendanube admin session.
  if (window.top && window.top !== window) {
    window.top.location.href = data.authorizeUrl;
  } else {
    window.location.href = data.authorizeUrl;
  }
  setStatus("Redirigiendo a Tiendanube para vincular la tienda...");
});

shareForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#reportName").value.trim();
  const password = $("#reportPassword").value.trim();

  const response = await fetch("/api/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      password,
      filters: currentFilters,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    setStatus(data.error || "No se pudo crear el link");
    return;
  }

  $("#shareLink").value = data.shareUrl;
  $("#pdfLink").value = `${data.pdfUrl}?password=${encodeURIComponent(password)}`;
  setStatus("Link y PDF generados");
});

$("#copyShareLink").addEventListener("click", async () => {
  await copyToClipboard($("#shareLink").value);
  setStatus("Link copiado");
});

$("#copyPdfLink").addEventListener("click", async () => {
  await copyToClipboard($("#pdfLink").value);
  setStatus("PDF copiado");
});

$("#shareShareLink").addEventListener("click", async () => {
  await nativeShare($("#shareLink").value);
});

$("#sharePdfLink").addEventListener("click", async () => {
  await nativeShare($("#pdfLink").value);
});

async function bootstrap() {
  const params = new URLSearchParams(window.location.search);
  const installedStoreId = params.get("store_id");
  const installed = params.get("installed") === "1";

  await loadStores();

  if (installed && installedStoreId) {
    const suggestedPassword = window.prompt(
      "Tienda vinculada. Define ahora una clave para este sistema de reporting:",
      ""
    );
    if (suggestedPassword && suggestedPassword.trim()) {
      const response = await fetch(`/api/stores/${encodeURIComponent(installedStoreId)}/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: suggestedPassword.trim() }),
      });

      if (response.ok) {
        $("#systemPassword").value = suggestedPassword.trim();
        $("#reportPassword").value = suggestedPassword.trim();
        setStatus("Tienda vinculada y clave guardada");
      }
    }
  }

  await loadSales();
  window.setInterval(loadSales, 20000);
}

bootstrap();
