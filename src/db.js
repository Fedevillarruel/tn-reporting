const path = require("path");
const fs = require("fs");

const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const dataPath =
  process.env.DB_PATH ||
  (isServerless ? "/tmp/reporting.json" : path.join(process.cwd(), "data", "reporting.json"));
const dataDir = path.dirname(dataPath);

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function defaultState() {
  return {
    settings: {},
    sales: [],
    reports: [],
    stores: [],
  };
}

function readState() {
  if (!fs.existsSync(dataPath)) {
    return defaultState();
  }

  try {
    const raw = fs.readFileSync(dataPath, "utf8");
    if (!raw.trim()) {
      return defaultState();
    }

    return {
      ...defaultState(),
      ...JSON.parse(raw),
    };
  } catch {
    return defaultState();
  }
}

function writeState(state) {
  fs.writeFileSync(dataPath, JSON.stringify(state, null, 2));
}

function mutateState(mutator) {
  const state = readState();
  const result = mutator(state);
  writeState(state);
  return result;
}

function getSetting(key) {
  return readState().settings[key];
}

function setSetting(key, value) {
  mutateState((state) => {
    state.settings[key] = value;
  });
}

function upsertSales(lines) {
  mutateState((state) => {
    const index = new Map(
      state.sales.map((item, itemIndex) => [
        `${item.store_id}:${item.order_id}:${item.product_id}:${item.variant_name}`,
        itemIndex,
      ])
    );

    for (const line of lines) {
      const key = `${line.store_id}:${line.order_id}:${line.product_id}:${line.variant_name}`;
      const existingIndex = index.get(key);
      if (existingIndex === undefined) {
        state.sales.push(line);
        index.set(key, state.sales.length - 1);
      } else {
        state.sales[existingIndex] = line;
      }
    }
  });
}

function parseFilterDate(value, { endOfMinute = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  if (endOfMinute && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) {
    return new Date(parsed.getTime() + 59999);
  }

  return parsed;
}

function filterSales(filters = {}) {
  const state = readState();
  const fromDate = parseFilterDate(filters.fromDate);
  const toDate = parseFilterDate(filters.toDate, { endOfMinute: true });

  return state.sales
    .filter((sale) => {
      if (filters.storeId && String(sale.store_id || "") !== String(filters.storeId)) {
        return false;
      }

      const saleDate = new Date(sale.created_at);

      if (fromDate && saleDate < fromDate) {
        return false;
      }

      if (toDate && saleDate > toDate) {
        return false;
      }

      if (
        filters.productName &&
        !String(sale.product_name || "")
          .toLowerCase()
          .includes(String(filters.productName).toLowerCase())
      ) {
        return false;
      }

      if (
        filters.variantName &&
        !String(sale.variant_name || "")
          .toLowerCase()
          .includes(String(filters.variantName).toLowerCase())
      ) {
        return false;
      }

      return true;
    })
    .sort((left, right) => new Date(right.created_at) - new Date(left.created_at));
}

function upsertStore(store) {
  mutateState((state) => {
    const index = state.stores.findIndex((item) => String(item.store_id) === String(store.store_id));
    const nextStore = {
      ...store,
      updated_at: new Date().toISOString(),
    };

    if (index === -1) {
      state.stores.push({
        ...nextStore,
        created_at: nextStore.created_at || new Date().toISOString(),
      });
    } else {
      state.stores[index] = {
        ...state.stores[index],
        ...nextStore,
      };
    }
  });
}

function listStores() {
  return readState().stores.slice().sort((a, b) => String(a.store_id).localeCompare(String(b.store_id)));
}

function getStoreById(storeId) {
  return readState().stores.find((store) => String(store.store_id) === String(storeId)) || null;
}

function createReport(report) {
  mutateState((state) => {
    state.reports.push(report);
  });
}

function getReportBySlug(slug) {
  return readState().reports.find((report) => report.slug === slug) || null;
}

module.exports = {
  getSetting,
  setSetting,
  upsertSales,
  filterSales,
  createReport,
  getReportBySlug,
  upsertStore,
  listStores,
  getStoreById,
};
