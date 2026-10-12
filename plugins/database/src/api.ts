import type { BerthPluginContext } from "@berth/plugin";

// The berth-database helper's API, through the box (berth.helper.request):
// every path is relative to the helper's /api/. berthd adds the helper's
// token itself; the plugin never sees or sends one.

// A value as the helper sends it: null is SQL NULL, and what JSON has no
// kind for (a numeric, a big integer, a timestamp, a uuid, bytea, json, an
// array) is a string, written as the database writes it.
export type Cell = null | boolean | number | string;

// What a connection's engine can do. The panel is built from this, not from
// what Postgres happens to do.
export interface Capabilities {
  // The SQL dialect, for the editor's highlighting and completion.
  dialect: string;
  // Tables are grouped in schemas (a level in the tree) or are one flat list.
  schemas: boolean;
  // The filter operators db/{conn}/rows takes.
  operators: string[];
  // The kinds of relation it has: "table", "view", "materialized_view".
  kinds: string[];
  // It takes writes at all (through the lock). False: read-only, always.
  writes: boolean;
  // An edit is all or nothing.
  transactions: boolean;
}

// What a helper that names no capabilities is taken to have: the least.
export const NO_CAPABILITIES: Capabilities = { dialect: "", schemas: true, operators: ["="], kinds: ["table"], writes: false, transactions: false };

export interface Connection {
  id: string;
  source: string;
  // The variable or service it came from, as the helper names it.
  label: string;
  engine: string;
  database: string;
  host: string;
  port: number;
  user: string;
  // Writes are on until then (unix ms); absent while they are locked.
  writes_until?: number;
  capabilities?: Capabilities;
}

export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  primary_key?: true;
}

export interface Index {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface ForeignKey {
  columns: string[];
  ref_schema: string;
  ref_table: string;
  ref_columns: string[];
}

export interface Table {
  name: string;
  kind: string;
  rows_estimate: number;
  columns: Column[];
  primary_key: string[];
  indexes: Index[];
  foreign_keys: ForeignKey[];
}

export interface Schema {
  name: string;
  tables: Table[];
}

export interface Order {
  column: string;
  desc?: true;
}

export interface Filter {
  column: string;
  op: string;
  value?: Cell;
}

export interface RowsRequest {
  schema: string;
  table: string;
  limit?: number;
  offset?: number;
  order_by?: Order[];
  filters?: Filter[];
}

// [row, column] of each cell that was cut at 4,000 characters.
export type Cut = [number, number][];

export interface Rows {
  columns: { name: string; type: string }[];
  rows: Cell[][];
  primary_key: string[];
  rows_estimate: number;
  more: boolean;
  cut?: Cut;
}

export interface QueryResult {
  columns: { name: string; type: string }[];
  rows: Cell[][];
  row_count: number;
  command: string;
  duration_ms: number;
  truncated: boolean;
  notices: string[];
  cut?: Cut;
}

export type Change = { op: "update"; key: Record<string, Cell>; set: Record<string, Cell> } | { op: "insert"; set: Record<string, Cell> } | { op: "delete"; key: Record<string, Cell> };

export interface Edited {
  updated: number;
  inserted: number;
  deleted: number;
}

// The rows a page of a table holds, the most one can, and the most a
// statement returns.
export const PAGE = 100;
export const MOST = 500;
export const QUERY_LIMIT = 1000;
// A cell longer than this arrives cut.
export const CUT_AT = 4000;
// How long writes stay on, which the helper decides; said before unlocking.
export const WRITES_FOR_MS = 15 * 60_000;

export function database(berth: BerthPluginContext) {
  const on = (conn: string, route: string) => `db/${encodeURIComponent(conn)}/${route}`;
  const post = <T,>(box: string, path: string, body: unknown) => berth.helper.request<T>(box, "POST", path, body);
  return {
    // The databases the helper knows for a worktree. None when its services
    // have not been started since the helper was turned on, or use no
    // database the helper can reach.
    connections: (box: string, source: string) => berth.helper.request<{ connections: Connection[] }>(box, "GET", `db/connections?${new URLSearchParams({ source })}`).then((r) => r.connections ?? []),
    schema: (box: string, conn: string) => berth.helper.request<{ schemas: Schema[] }>(box, "GET", on(conn, "schema")).then((r) => r.schemas ?? []),
    rows: (box: string, conn: string, req: RowsRequest) => post<Rows>(box, on(conn, "rows"), req),
    query: (box: string, conn: string, sql: string, limit = QUERY_LIMIT) => post<QueryResult>(box, on(conn, "query"), { sql, limit }),
    edit: (box: string, conn: string, schema: string, table: string, changes: Change[]) => post<Edited>(box, on(conn, "edit"), { schema, table, changes }),
    writes: (box: string, conn: string, turnOn: boolean) => post<{ writes_until?: number }>(box, on(conn, "writes"), { on: turnOn }),
  };
}

export type Database = ReturnType<typeof database>;

// What went wrong with a request, in the helper's words. code is what to
// branch on ("read_only", "row_conflict", "sql_error", "timeout"), hint what
// the helper adds (a SQL error's position, or what to try).
export interface Fault {
  message: string;
  code?: string;
  status?: number;
  hint?: string;
}

export function faultOf(err: unknown): Fault {
  const e = (err ?? {}) as { message?: unknown; code?: unknown; status?: unknown; detail?: { error?: { hint?: unknown } } };
  const hint = e.detail?.error && typeof e.detail.error === "object" ? e.detail.error.hint : undefined;
  return {
    message: typeof e.message === "string" && e.message ? e.message : String(err),
    code: typeof e.code === "string" ? e.code : undefined,
    status: typeof e.status === "number" ? e.status : undefined,
    hint: typeof hint === "string" && hint ? hint : undefined,
  };
}

// A helper from before a route existed answers 404 for it. (A box whose
// berthd has no helpers answers 404 too, with a code of its own.)
export const isOldHelper = (f: Fault) => f.status === 404 && f.code !== "box_outdated";
