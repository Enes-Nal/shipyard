import { ApiError } from "@/lib/api";

// Mock mode's berth-database helper (plugins/database): what a box's
// helpers/database/api/api/db/… answers, closely enough to build the panel
// on. It is loaded when the panel first asks (mock-helper.ts routes to it).
//
// The data is a made-up "acme" shop, built here from a seed so it is the
// same on every load: customers, products, orders and their items, an
// inventory with a two-column key, an audit log with no key at all, a view
// and a materialized view, foreign keys between them, and a second schema
// with a 41-column table. Every kind of value the helper sends is in it:
// NULLs and empty strings side by side, numerics and big integers as text,
// timestamps, uuids, bytea, jsonb, arrays, one long description and one
// over 4,000 characters, which arrives cut.
//
// shop / checkout-fix on devl has two connections: that Postgres, and
// "events" on a made-up engine ("driftdb") that says it has no schemas,
// three filter operators, a kind of relation nothing has heard of and no
// writes, to show the panel is built from what a connection says it can do.
// shop's main checkout has the Postgres alone. No other worktree has a
// database yet.
//
// Everything is in memory: filters, ordering and paging, the lock and its
// fifteen minutes, edits (all or nothing, 409 row_conflict for a keyed row
// that is gone) and a console that runs a small set of statements and
// answers anything else with a sql_error that says what it does run.
//
// ?db=none is a fleet where no worktree has a database yet, ?db=refused one
// whose database isn't answering the helper, and ?db=old a devl whose
// berth-database is from before the db/ routes (mock-helper.ts: it answers
// 404 until it is updated).

type Cell = null | boolean | number | string;

interface Column {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  primary_key?: true;
}

interface MockTable {
  schema: string;
  name: string;
  kind: string;
  columns: Column[];
  primary_key: string[];
  indexes: { name: string; columns: string[]; unique: boolean }[];
  foreign_keys: { columns: string[]; ref_schema: string; ref_table: string; ref_columns: string[] }[];
  rows: Cell[][];
}

interface MockConn {
  id: string;
  source: string;
  label: string;
  engine: string;
  database: string;
  host: string;
  port: number;
  user: string;
  capabilities: { dialect: string; schemas: boolean; operators: string[]; kinds: string[]; writes: boolean; transactions: boolean };
  tables: MockTable[];
  writesUntil?: number;
}

const scenario = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("db");

const WRITES_FOR_MS = 15 * 60_000;
const CUT_AT = 4000;

// A helper's own refusal, as the box passes it through: the words are
// inside "error" (lib/helper.ts lifts them out).
function refusal(status: number, code: string, message: string, hint?: string): ApiError {
  const err = new ApiError(String({}), status);
  err.detail = { error: { code, message, ...(hint ? { hint } : {}) } };
  return err;
}

// ---- The acme shop ----

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The newest row's moment: fixed, so a screenshot is the same every time.
const NOW = Date.UTC(2026, 8, 28, 9, 30, 0);
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const FIRST = ["Robin", "Sam", "Ada", "Noor", "Kai", "Maya", "Jonas", "Ines", "Tariq", "Lena", "Otto", "Priya", "Emre", "Zoe", "Hugo", "Anya", "Felix", "Mira", "Idris", "Clara"];
const LAST = ["Okafor", "Lindqvist", "Marsh", "Castellano", "Brandt", "Nakamura", "Oyelaran", "Petrov", "Haddad", "Whitlock", "Serrano", "Kowalski"];
const NOUNS = ["Kettle", "Lamp", "Notebook", "Backpack", "Mug", "Chair", "Desk mat", "Water bottle", "Headphones", "Keyboard", "Planter", "Blanket", "Candle", "Tote", "Speaker", "Clock"];
const ADJ = ["Harbor", "Slate", "Juniper", "Copper", "Fog", "Tidal", "Ember", "Linen"];
const PARAGRAPH =
  "Made in small batches for Acme by people who use it every day. The body is powder-coated steel with a matte finish that hides fingerprints, the handle is oiled beech, and every seam is welded and ground flush. It ships flat in recycled card with no plastic, and the two screws it needs are in the box with the key that turns them. ";

function shopTables(): MockTable[] {
  const r = seeded(1378);
  const pick = <T,>(list: T[]) => list[Math.floor(r() * list.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join("");
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

  const customers: Cell[][] = [];
  for (let id = 1; id <= 240; id++) {
    const first = FIRST[(id * 7) % FIRST.length];
    const last = LAST[(id * 5) % LAST.length];
    const plan = id % 9 === 0 ? "business" : id % 3 === 0 ? "team" : "free";
    // NULL, the empty string and a note, side by side in the first rows.
    const notes = id === 1 ? null : id === 2 ? "" : id === 3 ? "Prefers email. Never phone before noon." : id % 11 === 0 ? "Wholesale account, net 30." : null;
    customers.push([
      id,
      `${first}.${last}${id > 60 ? id : ""}@${id % 4 === 0 ? "acme.test" : "example.com"}`.toLowerCase(),
      `${first} ${last}`,
      plan,
      id % 5 === 0,
      (int(0, 25000) / 100).toFixed(2),
      notes,
      id % 6 === 0 ? "{vip,wholesale}" : id % 4 === 0 ? "{newsletter}" : "{}",
      id % 7 === 0 ? null : JSON.stringify({ source: pick(["ad", "referral", "organic"]), locale: pick(["en-GB", "en-US", "de-DE", "sv-SE"]) }),
      iso(NOW - (241 - id) * DAY * 1.7 - int(0, DAY)),
    ]);
  }

  const products: Cell[][] = [];
  for (let id = 1; id <= 64; id++) {
    const name = `${ADJ[id % ADJ.length]} ${NOUNS[id % NOUNS.length]}`;
    // One long description, and one over 4,000 characters that arrives cut.
    const description = id === 1 ? `The ${name}. ${PARAGRAPH.repeat(3)}`.trim() : id === 2 ? `The ${name}, in full. ${PARAGRAPH.repeat(17)}`.trim() : id % 8 === 0 ? null : `${name} for the desk, the shelf or the bag.`;
    products.push([
      id,
      `ACME-${String(1000 + id * 13)}`,
      name,
      description,
      int(4, 240) * 50 - 1,
      id % 10 === 0 ? null : (int(80, 4200) / 1000).toFixed(3),
      id % 13 !== 0,
      id % 4 === 0 ? null : `\\x89504e470d0a1a0a${hex(40)}`,
      JSON.stringify({ color: pick(["slate", "sand", "moss", "ink"]), sizes: id % 3 === 0 ? ["s", "m", "l"] : ["one"] }),
      iso(NOW - (70 - id) * DAY * 9),
    ]);
  }

  const STATUS = ["paid", "paid", "shipped", "shipped", "shipped", "pending", "refunded", "cancelled"];
  const orders: Cell[][] = [];
  const items: Cell[][] = [];
  let item = 20_000;
  for (let n = 0; n < 1280; n++) {
    const id = String(5001 + n);
    const status = STATUS[int(0, STATUS.length - 1)];
    const placed = NOW - (1280 - n) * 3_600_000 * 2.1;
    let total = 0;
    const lines = int(1, 5);
    for (let l = 0; l < lines; l++) {
      const product = int(1, 64);
      const quantity = int(1, 4);
      const price = products[product - 1][4] as number;
      total += quantity * price;
      items.push([String(++item), id, product, quantity, price]);
    }
    orders.push([id, int(1, 240), status, total, n % 17 === 0 ? "EUR" : "USD", iso(placed), status === "pending" || status === "cancelled" ? null : iso(placed + int(60_000, 900_000)), status === "shipped" ? uuid() : null, n % 29 === 0 ? "Leave with the neighbour at 14." : n % 31 === 0 ? "" : null]);
  }

  const inventory: Cell[][] = [];
  for (let id = 1; id <= 64; id++) {
    for (const warehouse of ["east", "north", "west"]) {
      const on_hand = int(0, 400);
      inventory.push([id, warehouse, on_hand, Math.min(on_hand, int(0, 40)), id % 5 === 0 ? null : iso(NOW - int(1, 60) * DAY).slice(0, 10)]);
    }
  }

  const ACTIONS = ["order.refund", "order.cancel", "product.update", "customer.merge", "inventory.adjust", "login"];
  const audit: Cell[][] = [];
  for (let n = 0; n < 420; n++) {
    const action = ACTIONS[int(0, ACTIONS.length - 1)];
    audit.push([iso(NOW - n * 3_600_000 * 1.3), n % 6 === 0 ? "system" : `${pick(FIRST).toLowerCase()}@acme.test`, action, action === "login" ? null : `${action.split(".")[0]}:${int(1, 900)}`, action === "login" ? null : JSON.stringify({ reason: pick(["requested", "duplicate", "stock count", "typo"]), by: "admin" })]);
  }

  const totals = customers
    .map((c) => {
      const mine = orders.filter((o) => o[1] === c[0]);
      return [c[0], c[2], String(mine.length), String(mine.reduce((sum, o) => sum + (o[3] as number), 0)), mine.length ? (mine[mine.length - 1][5] as string) : null] as Cell[];
    })
    .sort((a, b) => Number(b[3]) - Number(a[3]));

  const revenue: Cell[][] = [];
  for (let d = 0; d < 30; d++) {
    const day = iso(NOW - d * DAY).slice(0, 10);
    const mine = orders.filter((o) => (o[5] as string).startsWith(day));
    revenue.push([day, String(mine.length), `${mine.reduce((sum, o) => sum + (o[3] as number), 0)}.00`]);
  }

  const pk = (table: string, type = "integer"): Column => ({ name: "id", type, nullable: false, primary_key: true, default: `nextval('${table}_id_seq'::regclass)` });
  const col = (name: string, type: string, nullable = false, fallback?: string): Column => ({ name, type, nullable, ...(fallback ? { default: fallback } : {}) });
  const fk = (column: string, table: string, ref = "id") => ({ columns: [column], ref_schema: "public", ref_table: table, ref_columns: [ref] });

  const views = pageViews(seeded(1420));

  return [
    {
      schema: "public",
      name: "audit_log",
      kind: "table",
      columns: [col("at", "timestamp with time zone", false, "now()"), col("actor", "text"), col("action", "text"), col("subject", "text", true), col("detail", "jsonb", true)],
      primary_key: [],
      indexes: [{ name: "audit_log_at_idx", columns: ["at"], unique: false }],
      foreign_keys: [],
      rows: audit,
    },
    {
      schema: "public",
      name: "customers",
      kind: "table",
      columns: [
        pk("customers"),
        col("email", "text"),
        col("name", "text"),
        col("plan", "text", false, "'free'::text"),
        col("marketing_opt_in", "boolean", false, "false"),
        col("credit", "numeric(10,2)", false, "0"),
        col("notes", "text", true),
        col("tags", "text[]", false, "'{}'::text[]"),
        col("metadata", "jsonb", true),
        col("created_at", "timestamp with time zone", false, "now()"),
      ],
      primary_key: ["id"],
      indexes: [
        { name: "customers_pkey", columns: ["id"], unique: true },
        { name: "customers_email_key", columns: ["email"], unique: true },
      ],
      foreign_keys: [],
      rows: customers,
    },
    {
      schema: "public",
      name: "inventory",
      kind: "table",
      columns: [{ ...col("product_id", "integer"), primary_key: true }, { ...col("warehouse", "text"), primary_key: true }, col("on_hand", "integer", false, "0"), col("reserved", "integer", false, "0"), col("restocked_at", "date", true)],
      primary_key: ["product_id", "warehouse"],
      indexes: [{ name: "inventory_pkey", columns: ["product_id", "warehouse"], unique: true }],
      foreign_keys: [fk("product_id", "products")],
      rows: inventory,
    },
    {
      schema: "public",
      name: "order_items",
      kind: "table",
      columns: [pk("order_items", "bigint"), col("order_id", "bigint"), col("product_id", "integer"), col("quantity", "integer", false, "1"), col("unit_price_cents", "integer")],
      primary_key: ["id"],
      indexes: [
        { name: "order_items_pkey", columns: ["id"], unique: true },
        { name: "order_items_order_id_idx", columns: ["order_id"], unique: false },
      ],
      foreign_keys: [fk("order_id", "orders"), fk("product_id", "products")],
      rows: items,
    },
    {
      schema: "public",
      name: "orders",
      kind: "table",
      columns: [
        pk("orders", "bigint"),
        col("customer_id", "integer"),
        col("status", "text", false, "'pending'::text"),
        col("total_cents", "integer"),
        col("currency", "character(3)", false, "'USD'::bpchar"),
        col("placed_at", "timestamp with time zone", false, "now()"),
        col("settled_at", "timestamp with time zone", true),
        col("tracking", "uuid", true),
        col("note", "text", true),
      ],
      primary_key: ["id"],
      indexes: [
        { name: "orders_pkey", columns: ["id"], unique: true },
        { name: "orders_customer_id_placed_at_idx", columns: ["customer_id", "placed_at"], unique: false },
      ],
      foreign_keys: [fk("customer_id", "customers")],
      rows: orders,
    },
    {
      schema: "public",
      name: "products",
      kind: "table",
      columns: [
        pk("products"),
        col("sku", "text"),
        col("name", "text"),
        col("description", "text", true),
        col("price_cents", "integer"),
        col("weight_kg", "numeric(6,3)", true),
        col("active", "boolean", false, "true"),
        col("thumbnail", "bytea", true),
        col("attributes", "jsonb", false, "'{}'::jsonb"),
        col("created_at", "timestamp with time zone", false, "now()"),
      ],
      primary_key: ["id"],
      indexes: [
        { name: "products_pkey", columns: ["id"], unique: true },
        { name: "products_sku_key", columns: ["sku"], unique: true },
      ],
      foreign_keys: [],
      rows: products,
    },
    {
      schema: "public",
      name: "customer_totals",
      kind: "view",
      columns: [col("customer_id", "integer", true), col("name", "text", true), col("orders", "bigint", true), col("total_cents", "numeric", true), col("last_order_at", "timestamp with time zone", true)],
      primary_key: [],
      indexes: [],
      foreign_keys: [],
      rows: totals,
    },
    {
      schema: "public",
      name: "daily_revenue",
      kind: "materialized_view",
      columns: [col("day", "date", true), col("orders", "bigint", true), col("revenue_cents", "numeric", true)],
      primary_key: [],
      indexes: [{ name: "daily_revenue_day_idx", columns: ["day"], unique: true }],
      foreign_keys: [],
      rows: revenue,
    },
    views,
  ];
}

// analytics.page_views: 41 columns and 1,500 rows, for a grid that has to
// stay quick when a table is wide.
function pageViews(r: () => number): MockTable {
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T,>(list: T[]) => list[Math.floor(r() * list.length)];
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join("");
  const text = (name: string, values: (string | null)[]) => ({ name, type: "text", make: () => pick(values) as Cell });
  const num = (name: string, lo: number, hi: number, type = "integer") => ({ name, type, make: () => int(lo, hi) as Cell });
  const spec: { name: string; type: string; make(n: number): Cell }[] = [
    { name: "id", type: "bigint", make: (n) => String(900_000 + n) },
    { name: "session", type: "uuid", make: () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}` },
    { name: "customer_id", type: "integer", make: () => (r() < 0.4 ? null : int(1, 240)) },
    text("path", ["/", "/products", "/products/harbor-kettle", "/cart", "/checkout", "/orders", "/search?q=lamp"]),
    text("referrer", [null, null, "https://search.example/", "https://news.example/acme", ""]),
    text("utm_source", [null, null, "newsletter", "ad"]),
    text("utm_medium", [null, null, "email", "cpc"]),
    text("utm_campaign", [null, null, "autumn-sale", "launch"]),
    text("utm_term", [null]),
    text("utm_content", [null, "hero", "footer"]),
    text("device", ["desktop", "mobile", "tablet"]),
    text("os", ["macOS", "Windows", "iOS", "Android", "Linux"]),
    text("os_version", ["15.6", "11", "18.1", "15", "6.11"]),
    text("browser", ["Safari", "Chrome", "Firefox", "Edge"]),
    text("browser_version", ["18.0", "129.0", "131.0"]),
    num("screen_w", 360, 3840),
    num("screen_h", 640, 2160),
    num("viewport_w", 320, 2560),
    num("viewport_h", 480, 1400),
    text("locale", ["en-GB", "en-US", "de-DE", "sv-SE", "fr-FR"]),
    text("timezone", ["Europe/London", "America/New_York", "Europe/Berlin", "Europe/Stockholm"]),
    text("country", ["GB", "US", "DE", "SE", "FR"]),
    text("region", [null, "England", "New York", "Bavaria"]),
    text("city", [null, "London", "Brooklyn", "Munich", "Malmö"]),
    { name: "lat", type: "numeric(8,5)", make: () => (r() < 0.2 ? null : (int(-9000000, 9000000) / 100000).toFixed(5)) },
    { name: "lon", type: "numeric(8,5)", make: () => (r() < 0.2 ? null : (int(-18000000, 18000000) / 100000).toFixed(5)) },
    { name: "is_bot", type: "boolean", make: () => r() < 0.05 },
    { name: "is_returning", type: "boolean", make: () => r() < 0.4 },
    num("load_ms", 180, 4200),
    num("ttfb_ms", 20, 900),
    num("fcp_ms", 200, 2600),
    num("lcp_ms", 400, 5200),
    { name: "cls", type: "double precision", make: () => Math.round(r() * 300) / 1000 },
    num("inp_ms", 16, 600),
    num("scroll_pct", 0, 100, "smallint"),
    num("clicks", 0, 24, "smallint"),
    num("duration_ms", 400, 600_000),
    { name: "exit", type: "boolean", make: () => r() < 0.3 },
    text("experiment", [null, null, "checkout-copy", "pdp-gallery"]),
    text("variant", [null, null, "a", "b"]),
    { name: "created_at", type: "timestamp with time zone", make: (n) => iso(NOW - (1500 - n) * 41_000) },
  ];
  return {
    schema: "analytics",
    name: "page_views",
    kind: "table",
    columns: spec.map((s, i) => ({ name: s.name, type: s.type, nullable: i > 0 && s.name !== "created_at", ...(i === 0 ? { primary_key: true as const } : {}) })),
    primary_key: ["id"],
    indexes: [
      { name: "page_views_pkey", columns: ["id"], unique: true },
      { name: "page_views_created_at_idx", columns: ["created_at"], unique: false },
    ],
    foreign_keys: [{ columns: ["customer_id"], ref_schema: "public", ref_table: "customers", ref_columns: ["id"] }],
    rows: Array.from({ length: 1500 }, (_, n) => spec.map((s) => s.make(n))),
  };
}

// "events", on an engine nobody has heard of.
function driftTables(): MockTable[] {
  const r = seeded(4320);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const TOPICS = ["order.placed", "order.shipped", "payment.settled", "payment.failed", "stock.low"];
  const deliveries: Cell[][] = Array.from({ length: 64 }, (_, n) => {
    const ok = n % 7 !== 0;
    return [`dlv_${String(3000 + n)}`, TOPICS[n % TOPICS.length], ok ? 200 : 503, ok, n % 7 === 0 ? int(1, 5) : 0, iso(NOW - n * 97_000), ok ? null : "upstream timed out"];
  });
  const events: Cell[][] = Array.from({ length: 180 }, (_, n) => [String(88_000 + n), TOPICS[(n * 3) % TOPICS.length], JSON.stringify({ order: 5001 + n, attempt: 1 + (n % 3) }), iso(NOW - n * 31_000)]);
  const c = (name: string, type: string, nullable = false): Column => ({ name, type, nullable });
  return [
    { schema: "", name: "deliveries", kind: "table", columns: [{ ...c("id", "str"), primary_key: true }, c("topic", "str"), c("status", "i32"), c("ok", "bool"), c("retries", "i32"), c("sent", "ts"), c("error", "str", true)], primary_key: ["id"], indexes: [], foreign_keys: [], rows: deliveries },
    { schema: "", name: "webhook_events", kind: "stream", columns: [c("offset", "i64"), c("topic", "str"), c("payload", "doc"), c("at", "ts")], primary_key: [], indexes: [], foreign_keys: [], rows: events },
  ];
}

const POSTGRES = { dialect: "postgresql", schemas: true, operators: ["=", "!=", "<", "<=", ">", ">=", "like", "ilike", "is_null", "not_null"], kinds: ["table", "view", "materialized_view"], writes: true, transactions: true };
const DRIFT = { dialect: "driftql", schemas: false, operators: ["=", "!=", "like"], kinds: ["table", "stream"], writes: false, transactions: false };

let conns: MockConn[] | undefined;

function all(): MockConn[] {
  conns ??= [
    { id: "c1f04e2a", source: "shop/checkout-fix", label: "DATABASE_URL", engine: "postgres", database: "shop_checkout_fix", host: "127.0.0.1", port: 5432, user: "acme", capabilities: POSTGRES, tables: shopTables() },
    { id: "d7a93b10", source: "shop/checkout-fix", label: "EVENTS_URL", engine: "driftdb", database: "events", host: "127.0.0.1", port: 8765, user: "", capabilities: DRIFT, tables: driftTables() },
    { id: "a02c77e9", source: "shop", label: "DATABASE_URL", engine: "postgres", database: "shop_dev", host: "127.0.0.1", port: 5432, user: "acme", capabilities: POSTGRES, tables: shopTables() },
  ];
  return conns;
}

const writing = (c: MockConn) => c.capabilities.writes && c.writesUntil !== undefined && c.writesUntil > Date.now();

// ---- Values ----

const base = (type: string) =>
  type
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, "")
    .trim();
const NUMERIC = new Set(["integer", "bigint", "smallint", "numeric", "double precision", "real", "i32", "i64"]);
const isNumeric = (type: string) => NUMERIC.has(base(type));
const isBool = (type: string) => base(type) === "boolean" || base(type) === "bool";
// What JSON's numbers hold: the rest go as text, as the helper sends them.
const asNumber = (type: string) => ["integer", "smallint", "double precision", "real", "i32"].includes(base(type));

function compare(a: Cell, b: Cell, type: string): number {
  if (isNumeric(type)) return Number(a) - Number(b);
  if (typeof a === "boolean" || typeof b === "boolean") return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

const pattern = (like: string, flags: string) => new RegExp(`^${like.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, "[\\s\\S]*").replace(/_/g, "[\\s\\S]")}$`, flags);

function matches(cell: Cell, op: string, value: Cell, type: string): boolean {
  if (op === "is_null") return cell === null;
  if (op === "not_null") return cell !== null;
  // As in SQL: nothing compares with NULL.
  if (cell === null || value === null || value === undefined) return false;
  const v: Cell = isBool(type) && typeof value === "string" ? /^(t|true|1|yes|on)$/i.test(value) : value;
  switch (op) {
    case "=":
      return compare(cell, v, type) === 0;
    case "!=":
      return compare(cell, v, type) !== 0;
    case "<":
      return compare(cell, v, type) < 0;
    case "<=":
      return compare(cell, v, type) <= 0;
    case ">":
      return compare(cell, v, type) > 0;
    case ">=":
      return compare(cell, v, type) >= 0;
    case "like":
      return pattern(String(v), "").test(String(cell));
    case "ilike":
      return pattern(String(v), "i").test(String(cell));
    default:
      return false;
  }
}

// A value as it is stored for a column, from what was sent: a JSON scalar,
// or a string the database casts. A cast that can't be made is the error
// Postgres gives.
function cast(value: Cell, column: Column, table: MockTable): Cell {
  if (value === null) {
    if (!column.nullable) throw refusal(400, "sql_error", `null value in column "${column.name}" of relation "${table.name}" violates not-null constraint`);
    return null;
  }
  const type = base(column.type);
  if (isNumeric(type)) {
    const text = String(value).trim();
    const whole = ["integer", "bigint", "smallint"].includes(type);
    if (!(whole ? /^[+-]?\d+$/ : /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i).test(text)) throw refusal(400, "sql_error", `invalid input syntax for type ${type}: "${text}"`);
    return asNumber(type) ? Number(text) : text;
  }
  if (isBool(type)) {
    if (typeof value === "boolean") return value;
    if (/^(t|true|1|yes|on)$/i.test(String(value))) return true;
    if (/^(f|false|0|no|off)$/i.test(String(value))) return false;
    throw refusal(400, "sql_error", `invalid input syntax for type boolean: "${value}"`);
  }
  if (type === "jsonb" || type === "json") {
    try {
      JSON.parse(String(value));
    } catch {
      throw refusal(400, "sql_error", "invalid input syntax for type json", "The value is not valid JSON.");
    }
  }
  if (type === "uuid" && !/^[0-9a-f-]{32,36}$/i.test(String(value))) throw refusal(400, "sql_error", `invalid input syntax for type uuid: "${value}"`);
  return String(value);
}

// What a column takes when a new row leaves it out.
function fallback(column: Column, table: MockTable): Cell {
  if (column.default?.startsWith("nextval")) {
    const at = table.columns.indexOf(column);
    const next = table.rows.reduce((max, row) => Math.max(max, Number(row[at]) || 0), 0) + 1;
    return asNumber(column.type) ? next : String(next);
  }
  if (column.default === "now()") return new Date().toISOString();
  if (column.default !== undefined) {
    const d = column.default.replace(/::[\w\s[\]]+$/, "");
    if (d === "true" || d === "false") return d === "true";
    if (/^-?\d+$/.test(d)) return asNumber(column.type) ? Number(d) : d;
    return d.replace(/^'|'$/g, "");
  }
  if (!column.nullable) throw refusal(400, "sql_error", `null value in column "${column.name}" of relation "${table.name}" violates not-null constraint`, `Failing row has no value for ${column.name}.`);
  return null;
}

// Rows as they are sent: a cell longer than 4,000 characters is cut, and
// "cut" says which.
function sent(rows: Cell[][]): { rows: Cell[][]; cut?: [number, number][] } {
  const cut: [number, number][] = [];
  const out = rows.map((row, r) =>
    row.map((cell, c) => {
      if (typeof cell !== "string" || cell.length <= CUT_AT) return cell;
      cut.push([r, c]);
      return cell.slice(0, CUT_AT);
    }),
  );
  return cut.length ? { rows: out, cut } : { rows: out };
}

// ---- Routes ----

function tableOf(conn: MockConn, schema: string, name: string): MockTable {
  const t = conn.tables.find((x) => x.name === name && (x.schema === schema || (!conn.capabilities.schemas && !schema)));
  if (!t) throw refusal(404, "not_found", `No such table: ${schema ? `${schema}.` : ""}${name}.`);
  return t;
}

const at = (table: MockTable, column: string): number => {
  const i = table.columns.findIndex((c) => c.name === column);
  if (i < 0) throw refusal(400, "bad_request", `${table.name} has no column called ${column}.`);
  return i;
};

function schemaOf(conn: MockConn) {
  const names = [...new Set(conn.tables.map((t) => t.schema))].sort((a, b) => (a === "public" ? -1 : b === "public" ? 1 : a.localeCompare(b)));
  return {
    schemas: names.map((name) => ({
      name,
      tables: conn.tables
        .filter((t) => t.schema === name)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ rows, schema: _, ...t }) => ({ ...t, rows_estimate: t.kind === "view" ? 0 : rows.length })),
    })),
  };
}

interface RowsBody {
  schema?: string;
  table?: string;
  limit?: number;
  offset?: number;
  order_by?: { column: string; desc?: boolean }[];
  filters?: { column: string; op: string; value?: Cell }[];
}

function rowsOf(conn: MockConn, body: RowsBody) {
  const table = tableOf(conn, body.schema ?? "", body.table ?? "");
  const limit = Math.max(1, Math.min(500, body.limit ?? 100));
  const offset = Math.max(0, body.offset ?? 0);
  let rows = table.rows;
  for (const f of body.filters ?? []) {
    if (!conn.capabilities.operators.includes(f.op)) throw refusal(400, "bad_request", `${conn.engine} has no ${f.op} filter.`);
    const i = at(table, f.column);
    rows = rows.filter((row) => matches(row[i], f.op, f.value ?? null, table.columns[i].type));
  }
  const order = (body.order_by ?? []).map((o) => ({ i: at(table, o.column), desc: !!o.desc }));
  if (order.length) {
    rows = [...rows].sort((a, b) => {
      for (const o of order) {
        // NULLs last ascending, first descending, as Postgres orders them.
        const x = a[o.i];
        const y = b[o.i];
        const c = x === null ? (y === null ? 0 : 1) : y === null ? -1 : compare(x, y, table.columns[o.i].type);
        if (c !== 0) return o.desc ? -c : c;
      }
      return 0;
    });
  }
  const page = rows.slice(offset, offset + limit);
  return { columns: table.columns.map((c) => ({ name: c.name, type: c.type })), ...sent(page), primary_key: table.primary_key, rows_estimate: table.rows.length, more: offset + limit < rows.length };
}

type Change = { op: "update"; key: Record<string, Cell>; set: Record<string, Cell> } | { op: "insert"; set: Record<string, Cell> } | { op: "delete"; key: Record<string, Cell> };

function readOnly(conn: MockConn, what: string): ApiError {
  return refusal(403, "read_only", conn.capabilities.writes ? `Writes to ${conn.database} are locked: ${what} was not run.` : `${conn.engine} takes no writes.`, conn.capabilities.writes ? "Unlock writes first: POST db/{conn}/writes." : undefined);
}

function edit(conn: MockConn, body: { schema?: string; table?: string; changes?: Change[] }) {
  if (!writing(conn)) throw readOnly(conn, "the edit");
  const table = tableOf(conn, body.schema ?? "", body.table ?? "");
  if (table.kind !== "table") throw refusal(400, "bad_request", `${table.name} is a ${table.kind.replaceAll("_", " ")}: its rows can't be edited.`);
  // All or nothing: the changes are made to a copy, which takes the
  // table's place only when every one of them went through.
  const work: MockTable = { ...table, rows: table.rows.map((r) => [...r]) };
  const out = { updated: 0, inserted: 0, deleted: 0 };
  const find = (key: Record<string, Cell>) => {
    if (table.primary_key.length === 0) throw refusal(400, "bad_request", `${table.name} has no primary key: it takes inserts only.`);
    const cols = table.primary_key.map((c) => at(table, c));
    const i = work.rows.findIndex((row) => cols.every((c, n) => String(row[c]) === String(key[table.primary_key[n]])));
    if (i < 0) throw refusal(409, "row_conflict", `No row in ${table.name} with ${table.primary_key.map((c) => `${c} = ${key[c]}`).join(", ")} any more: it was changed or deleted since it was read.`, "Read the rows again.");
    return i;
  };
  const unique = () => {
    if (table.primary_key.length === 0) return;
    const cols = table.primary_key.map((c) => at(table, c));
    const seen = new Set<string>();
    for (const row of work.rows) {
      const id = JSON.stringify(cols.map((c) => String(row[c])));
      if (seen.has(id)) throw refusal(400, "sql_error", `duplicate key value violates unique constraint "${table.name}_pkey"`, `Key (${table.primary_key.join(", ")})=(${cols.map((c) => row[c]).join(", ")}) already exists.`);
      seen.add(id);
    }
  };
  for (const change of body.changes ?? []) {
    if (change.op === "delete") {
      work.rows.splice(find(change.key), 1);
      out.deleted++;
    } else if (change.op === "update") {
      const i = find(change.key);
      for (const [name, value] of Object.entries(change.set)) work.rows[i][at(table, name)] = cast(value, table.columns[at(table, name)], table);
      out.updated++;
    } else {
      for (const name of Object.keys(change.set)) at(table, name);
      work.rows.push(table.columns.map((c) => (c.name in change.set ? cast(change.set[c.name], c, work) : fallback(c, work))));
      out.inserted++;
    }
  }
  unique();
  table.rows = work.rows;
  return out;
}

// ---- The console ----

const UNDERSTOOD = "It runs SELECT from one table with WHERE (conditions joined by AND), ORDER BY, LIMIT and OFFSET; count(*); EXPLAIN; and UPDATE … SET … WHERE and DELETE FROM … WHERE.";
const WRITERS = new Set(["INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE", "COMMENT", "VACUUM", "REINDEX"]);
const STARTS = new Set([...WRITERS, "SELECT", "EXPLAIN", "SHOW", "WITH", "VALUES", "TABLE", "DO", "BEGIN", "COMMIT", "ROLLBACK", "SET"]);

const sqlError = (message: string, position?: number, hint?: string) => refusal(400, "sql_error", message, position !== undefined ? `position ${position + 1}` : hint);
const bare = (name: string) => name.replace(/^"|"$/g, "");

// The table a statement names, wherever in the text its name is.
function named(conn: MockConn, sql: string, name: string): MockTable {
  const [a, b] = name.split(".").map(bare);
  const table = conn.tables.find((t) => (b === undefined ? t.name === a && (t.schema === "public" || t.schema === "") : t.schema === a && t.name === b));
  if (!table) throw sqlError(`relation "${name}" does not exist`, sql.indexOf(name));
  return table;
}

interface Condition {
  i: number;
  op: string;
  value: Cell;
}

// WHERE a = 1 AND b LIKE 'x%' AND c IS NULL: nothing cleverer.
function conditions(sql: string, where: string, table: MockTable): Condition[] {
  const out: Condition[] = [];
  const offset = sql.indexOf(where);
  const part = /\s*("?[A-Za-z_]\w*"?)\s*(?:(is\s+not\s+null|is\s+null)|(=|!=|<>|<=|>=|<|>|\bilike\b|\blike\b)\s*('(?:[^']|'')*'|-?\d+(?:\.\d+)?|true|false))\s*(?:\band\b|$)/iy;
  let m: RegExpExecArray | null;
  let last = 0;
  while (last < where.length && (m = part.exec(where))) {
    const column = bare(m[1]);
    const i = table.columns.findIndex((c) => c.name === column);
    if (i < 0) throw sqlError(`column "${column}" does not exist`, offset + m.index + m[0].indexOf(m[1]));
    if (m[2]) out.push({ i, op: /not/i.test(m[2]) ? "not_null" : "is_null", value: null });
    else {
      const raw = m[4];
      const value: Cell = raw.startsWith("'") ? raw.slice(1, -1).replaceAll("''", "'") : /^(true|false)$/i.test(raw) ? raw.toLowerCase() === "true" : Number(raw);
      const op = m[3].toLowerCase();
      out.push({ i, op: op === "<>" ? "!=" : op, value });
    }
    last = part.lastIndex;
  }
  if (last < where.length) throw sqlError(`syntax error at or near "${where.slice(last).trim().split(/\s+/)[0]}"`, offset + last + (where.slice(last).length - where.slice(last).trimStart().length), UNDERSTOOD);
  return out;
}

const holds = (row: Cell[], table: MockTable, where: Condition[]) => where.every((c) => matches(row[c.i], c.op, c.value, table.columns[c.i].type));

function query(conn: MockConn, body: { sql?: string; limit?: number }) {
  const limit = Math.max(1, Math.min(5000, body.limit ?? 1000));
  const sql = (body.sql ?? "").trim().replace(/;\s*$/, "");
  if (!sql) throw sqlError("there is no statement to run");
  if (/;\s*\S/.test(sql.replace(/'(?:[^']|'')*'/g, "''").replace(/\$\$[\s\S]*?\$\$/g, ""))) throw sqlError("cannot run more than one statement at a time", undefined, "Run them one by one.");
  const first = /^[A-Za-z]+/.exec(sql)?.[0] ?? "";
  const word = first.toUpperCase();
  if (!STARTS.has(word)) throw sqlError(`syntax error at or near "${first || sql[0]}"`, 0);
  if (WRITERS.has(word) && !writing(conn)) throw readOnly(conn, `cannot execute ${word} in a read-only transaction`);
  const answer = (command: string, columns: { name: string; type: string }[], rows: Cell[][], count = rows.length, notices: string[] = []) => ({ columns, ...sent(rows.slice(0, limit)), row_count: Math.min(count, columns.length ? limit : count), command, duration_ms: Math.round((0.4 + rows.length * 0.004) * 100) / 100, truncated: rows.length > limit, notices });

  if (/^select\s+pg_sleep\(/i.test(sql)) throw refusal(408, "timeout", "canceling statement due to statement timeout", "The console stops a statement after 30 seconds.");
  if (/^do\b/i.test(sql)) {
    const said = /raise\s+notice\s+'((?:[^']|'')*)'/i.exec(sql);
    return answer("DO", [], [], 0, said ? [`NOTICE: ${said[1].replaceAll("''", "'")}`] : []);
  }
  if (/^select\s+1$/i.test(sql)) return answer("SELECT", [{ name: "?column?", type: "integer" }], [[1]]);
  if (/^select\s+now\(\)$/i.test(sql)) return answer("SELECT", [{ name: "now", type: "timestamp with time zone" }], [[new Date().toISOString()]]);
  if (/^select\s+version\(\)$/i.test(sql)) return answer("SELECT", [{ name: "version", type: "text" }], [["PostgreSQL 17.2 on x86_64-pc-linux-gnu, compiled by gcc, 64-bit"]]);
  if (/^select\s+current_database\(\)$/i.test(sql)) return answer("SELECT", [{ name: "current_database", type: "name" }], [[conn.database]]);

  const explain = /^explain\s+(?:\([^)]*\)\s*|analyze\s+)?([\s\S]+)$/i.exec(sql);
  if (explain) {
    const inner = explain[1];
    const from = /\b(?:from|update|into)\s+((?:"?\w+"?\.)?"?\w+"?)/i.exec(inner);
    if (!from) throw sqlError("mock database: EXPLAIN needs a statement that names a table", undefined, UNDERSTOOD);
    const table = named(conn, sql, from[1]);
    const where = /\bwhere\s+([\s\S]+?)(?:\s+order\s+by|\s+limit|$)/i.exec(inner)?.[1];
    const key = where && table.primary_key.length === 1 && new RegExp(`^"?${table.primary_key[0]}"?\\s*=`, "i").test(where.trim());
    const plan = key
      ? [`Index Scan using ${table.name}_pkey on ${table.name}  (cost=0.28..8.29 rows=1 width=${table.columns.length * 12})`, `  Index Cond: (${where!.trim()})`]
      : [`Seq Scan on ${table.name}  (cost=0.00..${(table.rows.length * 0.0125 + 1).toFixed(2)} rows=${where ? Math.max(1, Math.round(table.rows.length / 20)) : table.rows.length} width=${table.columns.length * 12})`, ...(where ? [`  Filter: (${where.trim()})`] : [])];
    return answer(
      "EXPLAIN",
      [{ name: "QUERY PLAN", type: "text" }],
      plan.map((line) => [line]),
    );
  }

  const select = /^select\s+([\s\S]+?)\s+from\s+((?:"?\w+"?\.)?"?\w+"?)(?:\s+where\s+([\s\S]+?))?(?:\s+order\s+by\s+("?\w+"?)(?:\s+(asc|desc))?)?(?:\s+limit\s+(\d+))?(?:\s+offset\s+(\d+))?$/i.exec(sql);
  if (select) {
    const table = named(conn, sql, select[2]);
    const where = select[3] ? conditions(sql, select[3], table) : [];
    let rows = table.rows.filter((row) => holds(row, table, where));
    if (/^count\(\s*\*\s*\)$/i.test(select[1].trim())) return answer("SELECT", [{ name: "count", type: "bigint" }], [[String(rows.length)]]);
    const wanted =
      select[1].trim() === "*"
        ? table.columns.map((_, i) => i)
        : select[1].split(",").map((raw) => {
            const name = bare(raw.trim());
            const i = table.columns.findIndex((c) => c.name === name);
            if (!/^"?\w+"?$/.test(raw.trim())) throw sqlError(`mock database: it selects columns by name, * or count(*), and “${raw.trim()}” is none of those`, sql.indexOf(raw.trim()), UNDERSTOOD);
            if (i < 0) throw sqlError(`column "${name}" does not exist`, sql.indexOf(raw.trim()));
            return i;
          });
    if (select[4]) {
      const name = bare(select[4]);
      const i = table.columns.findIndex((c) => c.name === name);
      if (i < 0) throw sqlError(`column "${name}" does not exist`, sql.lastIndexOf(select[4]));
      const desc = /desc/i.test(select[5] ?? "");
      rows = [...rows].sort((a, b) => {
        const c = a[i] === null ? (b[i] === null ? 0 : 1) : b[i] === null ? -1 : compare(a[i], b[i], table.columns[i].type);
        return desc ? -c : c;
      });
    }
    const offset = select[7] ? Number(select[7]) : 0;
    rows = rows.slice(offset, select[6] ? offset + Number(select[6]) : undefined);
    return answer(
      "SELECT",
      wanted.map((i) => ({ name: table.columns[i].name, type: table.columns[i].type })),
      rows.map((row) => wanted.map((i) => row[i])),
    );
  }

  const remove = /^delete\s+from\s+((?:"?\w+"?\.)?"?\w+"?)\s+where\s+([\s\S]+)$/i.exec(sql);
  if (remove) {
    const table = named(conn, sql, remove[1]);
    const where = conditions(sql, remove[2], table);
    const before = table.rows.length;
    table.rows = table.rows.filter((row) => !holds(row, table, where));
    return answer("DELETE", [], [], before - table.rows.length);
  }
  const update = /^update\s+((?:"?\w+"?\.)?"?\w+"?)\s+set\s+("?\w+"?)\s*=\s*('(?:[^']|'')*'|-?\d+(?:\.\d+)?|true|false|null)\s+where\s+([\s\S]+)$/i.exec(sql);
  if (update) {
    const table = named(conn, sql, update[1]);
    const column = bare(update[2]);
    const i = table.columns.findIndex((c) => c.name === column);
    if (i < 0) throw sqlError(`column "${column}" of relation "${table.name}" does not exist`, sql.indexOf(update[2]));
    const raw = update[3];
    const value = cast(/^null$/i.test(raw) ? null : raw.startsWith("'") ? raw.slice(1, -1).replaceAll("''", "'") : /^(true|false)$/i.test(raw) ? raw.toLowerCase() === "true" : raw, table.columns[i], table);
    const where = conditions(sql, update[4], table);
    let n = 0;
    for (const row of table.rows) {
      if (!holds(row, table, where)) continue;
      row[i] = value;
      n++;
    }
    return answer("UPDATE", [], [], n);
  }
  throw sqlError("mock database: this statement isn't one it understands", undefined, UNDERSTOOD);
}

// databaseCall answers the helper's /api/db/… routes. empty is a helper
// that knows no worktree's database: one just installed, or one whose data
// was removed.
export function databaseCall(method: string, route: string, q: URLSearchParams, body: unknown, empty: boolean): unknown {
  if (method === "GET" && route === "db/connections") {
    const source = q.get("source") ?? "";
    const mine = empty || scenario === "none" ? [] : all().filter((c) => c.source === source);
    return { connections: mine.map((c) => ({ id: c.id, source: c.source, label: c.label, engine: c.engine, database: c.database, host: c.host, port: c.port, user: c.user, capabilities: c.capabilities, ...(writing(c) ? { writes_until: c.writesUntil } : {}) })) };
  }
  const m = /^db\/([^/]+)\/(schema|rows|query|edit|writes)$/.exec(route);
  const conn = m && !empty && scenario !== "none" ? all().find((c) => c.id === decodeURIComponent(m[1])) : undefined;
  if (!m) throw refusal(404, "not_found", `No such route: ${method} /api/${route}.`);
  if (!conn) throw refusal(404, "not_found", "No such connection: its worktree's services may have been restarted.");
  const what = m[2];
  if (what === "writes" && method === "POST") {
    if (!conn.capabilities.writes) throw readOnly(conn, "");
    conn.writesUntil = (body as { on?: boolean } | undefined)?.on ? Date.now() + WRITES_FOR_MS : undefined;
    return conn.writesUntil ? { writes_until: conn.writesUntil } : {};
  }
  // The helper has the address, and nothing answers at it.
  if (scenario === "refused") throw refusal(502, "db_unreachable", `dial tcp ${conn.host}:${conn.port}: connect: connection refused`, `Is ${conn.database}'s server running on the box?`);
  if (what === "schema" && method === "GET") return schemaOf(conn);
  if (what === "rows" && method === "POST") return rowsOf(conn, (body ?? {}) as RowsBody);
  if (what === "query" && method === "POST") return query(conn, (body ?? {}) as { sql?: string; limit?: number });
  if (what === "edit" && method === "POST") return edit(conn, (body ?? {}) as { schema?: string; table?: string; changes?: Change[] });
  throw refusal(405, "method_not_allowed", `${method} is not how /api/${route} is asked.`);
}
