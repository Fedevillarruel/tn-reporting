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
        `${item.order_id}:${item.product_id}:${item.variant_name}`,
        itemIndex,
      ])
    );

    for (const line of lines) {
      const key = `${line.order_id}:${line.product_id}:${line.variant_name}`;
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

function filterSales(filters = {}) {
  const state = readState();

  return state.sales
    .filter((sale) => {
      if (filters.fromDate && new Date(sale.created_at) < new Date(filters.fromDate)) {
        return false;
      }

      if (filters.toDate && new Date(sale.created_at) > new Date(filters.toDate)) {
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

      return true;
    })
    .sort((left, right) => new Date(right.created_at) - new Date(left.created_at));
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
};
