const axios = require("axios");

const API_BASE = "https://api.tiendanube.com/v1";
const OAUTH_TOKEN_URL = process.env.TN_OAUTH_TOKEN_URL || "https://www.tiendanube.com/apps/authorize/token";

function normalizeOrderLine(order, line, storeId) {
  const quantity = Number(line.quantity || 0);
  const price = Number(line.price || 0);

  return {
    store_id: String(storeId),
    order_id: Number(order.id),
    order_number: order.number ? String(order.number) : String(order.id),
    created_at: order.created_at,
    customer_name: order.customer?.name || "Cliente no identificado",
    product_id: Number(line.product_id || 0),
    product_name: line.name || "Producto sin nombre",
    variant_name: line.variant_name || "Sin variante",
    quantity,
    price,
    total: Number((quantity * price).toFixed(2)),
    updated_at: new Date().toISOString(),
  };
}

async function fetchOrders({ storeId, accessToken, page = 1, perPage = 100 }) {
  const url = `${API_BASE}/${storeId}/orders`;
  const response = await axios.get(url, {
    params: { page, per_page: perPage },
    headers: {
      Authentication: `bearer ${accessToken}`,
      "User-Agent": "reporting-tn-app (contact: local)",
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });

  return response.data || [];
}

async function fetchAllOrderLines({ storeId, accessToken, maxPages = 20 }) {
  const lines = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const orders = await fetchOrders({ storeId, accessToken, page });

    if (!orders.length) {
      break;
    }

    for (const order of orders) {
      for (const line of order.products || []) {
        lines.push(normalizeOrderLine(order, line, storeId));
      }
    }

    if (orders.length < 100) {
      break;
    }
  }

  return lines;
}

async function exchangeOAuthCode({ code, clientId, clientSecret }) {
  const response = await axios.post(
    OAUTH_TOKEN_URL,
    {
      client_id: String(clientId),
      client_secret: String(clientSecret),
      grant_type: "authorization_code",
      code: String(code),
    },
    {
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );

  return response.data || {};
}

module.exports = {
  fetchAllOrderLines,
  exchangeOAuthCode,
};
