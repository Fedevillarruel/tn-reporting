const $ = (selector) => document.querySelector(selector);

const connectionForm = $("#connection-form");
const syncBtn = $("#syncBtn");
const syncStatus = $("#syncStatus");
const applyFiltersBtn = $("#applyFilters");
const shareForm = $("#share-form");

let currentFilters = {
  fromDate: "",
  toDate: "",
  productName: "",
};

function getFilters() {
  return {
    fromDate: $("#fromDate").value ? new Date($("#fromDate").value).toISOString() : "",
    toDate: $("#toDate").value ? new Date($("#toDate").value).toISOString() : "",
    productName: $("#productName").value.trim(),
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
      <td>${row.product_name}</td>
      <td>${row.quantity}</td>
      <td>$${Number(row.total).toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function loadConnection() {
  const response = await fetch("/api/connection");
  const data = await response.json();
  $("#storeId").value = data.storeId || "";
}

async function loadSales() {
  const params = new URLSearchParams();
  if (currentFilters.fromDate) params.set("fromDate", currentFilters.fromDate);
  if (currentFilters.toDate) params.set("toDate", currentFilters.toDate);
  if (currentFilters.productName) params.set("productName", currentFilters.productName);

  const response = await fetch(`/api/sales?${params.toString()}`);
  const data = await response.json();
  renderSummary(data.summary);
  renderRows(data.rows);
}

connectionForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const storeId = $("#storeId").value.trim();
  const accessToken = $("#accessToken").value.trim();

  const response = await fetch("/api/connection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storeId, accessToken }),
  });

  if (!response.ok) {
    syncStatus.textContent = "No se pudo guardar la conexion";
    return;
  }

  syncStatus.textContent = "Conexion guardada";
});

syncBtn.addEventListener("click", async () => {
  syncStatus.textContent = "Sincronizando...";

  const response = await fetch("/api/tiendanube/sync", {
    method: "POST",
  });

  const data = await response.json();
  if (!response.ok) {
    syncStatus.textContent = `Error: ${data.error || "fallo de sincronizacion"}`;
    return;
  }

  syncStatus.textContent = `Ventas sincronizadas: ${data.importedRows}`;
  await loadSales();
});

applyFiltersBtn.addEventListener("click", async () => {
  currentFilters = getFilters();
  await loadSales();
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
    $("#shareLink").textContent = data.error || "No se pudo crear el link";
    return;
  }

  $("#shareLink").textContent = `Link: ${data.shareUrl}`;
  $("#pdfLink").textContent = `PDF: ${data.pdfUrl}?password=${encodeURIComponent(password)}`;
});

loadConnection().then(loadSales);
