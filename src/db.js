const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const dbPath = process.env.DB_PATH || (isServerless ? "/tmp/reporting.db" : path.join(process.cwd(), "data", "reporting.db"));
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL,
    order_number TEXT,
    created_at TEXT NOT NULL,
    customer_name TEXT,
    product_id INTEGER,
    product_name TEXT,
    variant_name TEXT,
    quantity INTEGER NOT NULL,
    price REAL NOT NULL,
    total REAL NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(order_id, product_id, variant_name)
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password TEXT NOT NULL,
    filters_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at);
  CREATE INDEX IF NOT EXISTS idx_sales_product_name ON sales(product_name);
`);

function setSetting(key, value) {
  const stmt = db.prepare(`
    INSERT INTO app_settings(key, value)
    VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `);
  stmt.run(key, value);
}

function getSetting(key) {
  return db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key)?.value;
}

module.exports = {
  db,
  setSetting,
  getSetting,
};
