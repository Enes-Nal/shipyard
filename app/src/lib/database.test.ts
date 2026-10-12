// node --experimental-strip-types --test src/lib/database.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { type Cell, faultOf, isOldBox, isOldHelper, lostHelper } from "../../../plugins/database/src/api.ts";
import { skewOf, untilHere, WRITES_FOR_MS } from "../../../plugins/database/src/clock.ts";
import { editText, isLong, parseInput, pretty, quote, sameCell, show } from "../../../plugins/database/src/engines/families.ts";
import { engineOf, tableName } from "../../../plugins/database/src/engines/index.ts";
import { type Draft, filtersOf, jumpFilters, nextOrder, opsFor } from "../../../plugins/database/src/filters.ts";
import { kindOf, rulesFor } from "../../../plugins/database/src/rules.ts";
import { namePart, sourceOf } from "../../../plugins/database/src/source.ts";
import { addRow, changes, count, dropRows, keyed, keyText, NOTHING, removeNew, removeRows, review, rowId, setCell, setNew, summary, undo } from "../../../plugins/database/src/staged.ts";
import { lineAndColumn, markAt, oneLine, remember, split, statementAt } from "../../../plugins/database/src/statements.ts";

const pg = engineOf("postgres");

// ---- A worktree's name in the helper ----

// The same rule as Leadline's helper (app/src/lib/leadline.test.ts): the box
// daemon files a worktree's services under one name for every helper.
test("a worktree's source is its project and its name, and the project alone for the main checkout", () => {
  assert.equal(sourceOf({ location: "acme", worktree: "fix-orders" }), "acme/fix-orders");
  assert.equal(sourceOf({ location: "acme", worktree: "acme", main: true }), "acme");
  assert.equal(sourceOf({ location: "acme", worktree: "acme" }), "acme");
  assert.equal(sourceOf({ location: "acme", worktree: "" }), "acme");
  assert.equal(sourceOf({ location: "acme shop", worktree: "feat/fix:orders" }), "acme-shop/feat-fix-orders");
  assert.equal(sourceOf({ location: "", worktree: "fix-orders" }), "fix-orders");
  assert.equal(namePart("  feat/fix:orders\\v2\tnow "), "feat-fix-orders-v2-now");
  assert.equal(namePart("x".repeat(80)), "x".repeat(60));
  assert.equal(namePart(`${"x".repeat(59)}é`), "x".repeat(59));
});

// ---- Engines ----

test("Postgres's types fall into families, however a type is written", () => {
  const cases: [string, string][] = [
    ["integer", "integer"],
    ["int8", "integer"],
    ["bigint", "integer"],
    ["numeric(10,2)", "decimal"],
    ["double precision", "decimal"],
    ["boolean", "boolean"],
    ["text", "text"],
    ["character varying(255)", "text"],
    ["character(3)", "text"],
    ["timestamp with time zone", "time"],
    ["timestamp(3) without time zone", "time"],
    ["date", "time"],
    ["jsonb", "json"],
    ["bytea", "binary"],
    ["uuid", "uuid"],
    ["text[]", "array"],
    ["_int4", "array"],
    ["integer ARRAY", "array"],
    ["inet", "other"],
    ["order_status", "other"],
  ];
  for (const [type, family] of cases) assert.equal(pg.family(type), family, type);
  assert.equal(pg.name, "PostgreSQL");
  assert.equal(pg.edits, true);
  assert.equal(pg.explain?.("SELECT 1"), "EXPLAIN SELECT 1");
});

test("an engine the plugin has never heard of is shown plainly and never edited in the grid", () => {
  const e = engineOf("driftdb");
  assert.equal(e.id, "driftdb");
  assert.equal(e.name, "driftdb");
  assert.equal(e.edits, false);
  assert.equal(e.family("i64"), "other");
  assert.equal(e.explain, undefined);
  assert.equal(engineOf("").name, "Database");
});

test("a table is named without its schema where the engine lets that be left out", () => {
  assert.equal(tableName(pg, "public", "orders"), "orders");
  assert.equal(tableName(pg, "analytics", "page_views"), "analytics.page_views");
  assert.equal(tableName(engineOf("driftdb"), "", "deliveries"), "deliveries");
  // For SQL, a name that needs quotes gets them.
  assert.equal(tableName(pg, "public", "Order Items", true), '"Order Items"');
  assert.equal(tableName(pg, "analytics", "page_views", true), "analytics.page_views");
});

// ---- Values: NULL is never the empty string ----

test("NULL and the empty string are shown as two different things, and neither as an empty cell", () => {
  assert.deepEqual(show(null, "text"), { kind: "null", text: "NULL", right: false });
  assert.deepEqual(show("", "text"), { kind: "empty", text: "empty", right: false });
  assert.notEqual(show(null, "text").text, show("", "text").text);
  assert.equal(show("NULL", "text").kind, "value");
  assert.deepEqual(show(0, "integer"), { kind: "value", text: "0", right: true });
  assert.deepEqual(show(false, "boolean"), { kind: "value", text: "false", right: false });
  // A numeric and a big integer arrive as text, and still line up as numbers.
  assert.deepEqual(show("12.50", "decimal"), { kind: "value", text: "12.50", right: true });
  assert.deepEqual(show("9007199254740993", "integer"), { kind: "value", text: "9007199254740993", right: true });
});

test("a cell draws one line of a value, and a long one opens in the sheet", () => {
  assert.equal(show("line one\nline two\tend", "text").text, "line one↵line two→end");
  assert.equal(show("x".repeat(5000), "text").text.length, 240);
  assert.equal(isLong("x".repeat(81)), true);
  assert.equal(isLong("two\nlines"), true);
  assert.equal(isLong("short"), false);
  assert.equal(isLong(null), false);
  assert.equal(pretty('{"a":1,"b":[2]}', "json"), '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  assert.equal(pretty('{"a":', "json"), '{"a":');
  assert.equal(pretty(null, "text"), "NULL");
});

test("what is typed becomes a value for its column, and an empty box is never NULL", () => {
  // Text: as typed, the empty string included.
  assert.deepEqual(parseInput("", "text"), { ok: true, value: "" });
  assert.deepEqual(parseInput("  padded ", "text"), { ok: true, value: "  padded " });
  assert.deepEqual(parseInput("NULL", "text"), { ok: true, value: "NULL" });
  // Anywhere else an empty box is not a value: NULL is asked for by name.
  for (const family of ["integer", "decimal", "boolean", "time", "json", "uuid", "binary", "array", "other"] as const) {
    assert.equal(parseInput("", family).ok, false, family);
    assert.equal(parseInput("   ", family).ok, false, family);
  }
  assert.deepEqual(parseInput(" 42 ", "integer"), { ok: true, value: 42 });
  assert.deepEqual(parseInput("-7", "integer"), { ok: true, value: -7 });
  // Past what a JSON number holds exactly, the digits go as text.
  assert.deepEqual(parseInput("9007199254740993", "integer"), { ok: true, value: "9007199254740993" });
  assert.equal(parseInput("4.2", "integer").ok, false);
  assert.equal(parseInput("abc", "integer").ok, false);
  assert.deepEqual(parseInput("12.50", "decimal"), { ok: true, value: "12.50" });
  assert.deepEqual(parseInput("1e3", "decimal"), { ok: true, value: "1e3" });
  assert.deepEqual(parseInput("NaN", "decimal"), { ok: true, value: "NaN" });
  assert.equal(parseInput("twelve", "decimal").ok, false);
  assert.deepEqual(parseInput("TRUE", "boolean"), { ok: true, value: true });
  assert.deepEqual(parseInput("f", "boolean"), { ok: true, value: false });
  assert.equal(parseInput("maybe", "boolean").ok, false);
  assert.deepEqual(parseInput('{"a": 1}', "json"), { ok: true, value: '{"a": 1}' });
  assert.equal(parseInput('{"a": ', "json").ok, false);
  assert.equal(parseInput("3f2b9c1e-8a47-4d0e-a1b2-0c9d8e7f6a5b", "uuid").ok, true);
  assert.equal(parseInput("not-a-uuid", "uuid").ok, false);
  assert.deepEqual(parseInput("\\x00ff", "binary"), { ok: true, value: "\\x00ff" });
  assert.equal(parseInput("00ff", "binary").ok, false);
  // A time, an array, a type with no rule: as written, for the database to read.
  assert.deepEqual(parseInput("2026-09-28T09:30:00Z", "time"), { ok: true, value: "2026-09-28T09:30:00Z" });
  assert.deepEqual(parseInput("{vip,wholesale}", "array"), { ok: true, value: "{vip,wholesale}" });
});

test("an editor starts with the value, and with nothing for NULL", () => {
  assert.equal(editText(null), "");
  assert.equal(editText(""), "");
  assert.equal(editText(12), "12");
  assert.equal(editText(true), "true");
  assert.equal(editText("as it is"), "as it is");
});

test("two cells are the same value only when they are: NULL is not the empty string", () => {
  assert.equal(sameCell(null, null), true);
  assert.equal(sameCell(null, ""), false);
  assert.equal(sameCell("", null), false);
  assert.equal(sameCell("", ""), true);
  // A float arrives as a number and is typed as text.
  assert.equal(sameCell(1.5, "1.5"), true);
  assert.equal(sameCell("12", 12), true);
  assert.equal(sameCell(12, 13), false);
  assert.equal(sameCell(true, "true"), false);
  assert.equal(quote(null), "NULL");
  assert.equal(quote(""), "''");
  assert.equal(quote("pending"), "'pending'");
  assert.equal(quote(42), "42");
  assert.equal(quote("x".repeat(100), 10), `'${"x".repeat(10)}…'`);
});

// ---- Staged changes ----

const pk = ["id"];
const row = (id: number, status: string, note: Cell = null) => ({ id, status, note });

test("edits to one row are one update, and an edit back to what was read is no change", () => {
  const r = row(12, "pending");
  let s = setCell(NOTHING, pk, r, "status", "paid");
  s = setCell(s, pk, r, "note", "");
  assert.equal(count(s), 1);
  assert.deepEqual(changes(s), [{ op: "update", key: { id: 12 }, set: { status: "paid", note: "" } }]);
  // NULL to the empty string is a change; back to NULL is none.
  s = setCell(s, pk, r, "note", null);
  assert.deepEqual(changes(s), [{ op: "update", key: { id: 12 }, set: { status: "paid" } }]);
  s = setCell(s, pk, r, "status", "pending");
  assert.equal(count(s), 0);
  assert.deepEqual(s.updates, {});
});

test("a row is named by its key as it was read, even when the key itself is edited", () => {
  const r = row(12, "pending");
  const s = setCell(NOTHING, pk, r, "id", 99);
  assert.deepEqual(changes(s), [{ op: "update", key: { id: 12 }, set: { id: 99 } }]);
  // A two-column key.
  const stock = { product_id: 4, warehouse: "east", on_hand: 10 };
  const t = setCell(NOTHING, ["product_id", "warehouse"], stock, "on_hand", 9);
  assert.deepEqual(changes(t), [{ op: "update", key: { product_id: 4, warehouse: "east" }, set: { on_hand: 9 } }]);
  assert.equal(keyText({ product_id: 4, warehouse: "east" }), "product_id = 4, warehouse = 'east'");
  assert.equal(rowId(stock, ["product_id", "warehouse"]), '[4,"east"]');
});

test("deleting a row drops what was staged for it, and it takes no more edits", () => {
  const r = row(12, "pending");
  let s = setCell(NOTHING, pk, r, "status", "paid");
  s = removeRows(s, pk, [r, row(13, "paid")]);
  assert.equal(count(s), 2);
  assert.deepEqual(changes(s), [
    { op: "delete", key: { id: 12 } },
    { op: "delete", key: { id: 13 } },
  ]);
  assert.equal(setCell(s, pk, r, "status", "shipped"), s);
});

test("a new row sends only what was typed, and a cell taken back takes its default", () => {
  let [s, id] = addRow(NOTHING);
  assert.equal(id, "new-1");
  s = setNew(s, id, "status", "paid");
  s = setNew(s, id, "note", null);
  assert.deepEqual(changes(s), [{ op: "insert", set: { status: "paid", note: null } }]);
  s = setNew(s, id, "note", undefined);
  assert.deepEqual(changes(s), [{ op: "insert", set: { status: "paid" } }]);
  const [two, second] = addRow(s);
  assert.equal(second, "new-2");
  assert.equal(count(two), 2);
  assert.equal(count(removeNew(two, ["new-1"])), 1);
  // A name is not used twice, whatever was taken back.
  assert.equal(addRow(removeNew(two, ["new-2"]))[1], "new-3");
});

test("an edit is sent as deletes, then updates, then inserts, and Review lists it the same way", () => {
  let s = setCell(NOTHING, pk, row(12, "pending"), "status", "paid");
  s = removeRows(s, pk, [row(15, "paid")]);
  s = setNew(addRow(s)[0], "new-1", "status", "pending");
  assert.deepEqual(
    changes(s).map((c) => c.op),
    ["delete", "update", "insert"],
  );
  assert.equal(summary(s), "1 edited, 1 added, 1 deleted");
  const lines = review(s);
  assert.deepEqual(
    lines.map((l) => [l.kind, l.title]),
    [
      ["delete", "id = 15"],
      ["update", "id = 12"],
      ["insert", "New row"],
    ],
  );
  // Old → new for an update; a new row has no old.
  assert.deepEqual(lines[1].fields, [{ column: "status", was: "pending", now: "paid" }]);
  assert.deepEqual(lines[2].fields, [{ column: "status", now: "pending" }]);
  // Each line can be taken back on its own.
  assert.deepEqual(
    review(undo(s, lines[0])).map((l) => l.kind),
    ["update", "insert"],
  );
  assert.equal(count(undo(undo(undo(s, lines[0]), lines[1]), lines[2])), 0);
});

test("after a conflict, the rows that are gone can be dropped and the rest stay staged", () => {
  let s = setCell(NOTHING, pk, row(12, "pending"), "status", "paid");
  s = setCell(s, pk, row(13, "pending"), "status", "paid");
  s = removeRows(s, pk, [row(15, "paid")]);
  assert.deepEqual(
    keyed(s).map((k) => k.key),
    [{ id: 15 }, { id: 12 }, { id: 13 }],
  );
  const left = dropRows(s, [rowId(row(12, ""), pk), rowId(row(15, ""), pk)]);
  assert.deepEqual(changes(left), [{ op: "update", key: { id: 13 }, set: { status: "paid" } }]);
});

// ---- What may be edited ----

test("a view, a table with no key and an engine without writes are browse-only, and say why", () => {
  const caps = { writes: true };
  assert.deepEqual(rulesFor({ name: "orders", kind: "table", primary_key: ["id"] }, pg, caps), { rows: true, inserts: true });
  const view = rulesFor({ name: "customer_totals", kind: "view", primary_key: [] }, pg, caps);
  assert.deepEqual([view.rows, view.inserts], [false, false]);
  assert.match(view.why!, /customer_totals is a view/);
  const mat = rulesFor({ name: "daily_revenue", kind: "materialized_view", primary_key: [] }, pg, caps);
  assert.match(mat.why!, /materialized view/);
  // No key: a row can't be named, so it can be added and nothing else.
  const log = rulesFor({ name: "audit_log", kind: "table", primary_key: [] }, pg, caps);
  assert.deepEqual([log.rows, log.inserts], [false, true]);
  assert.match(log.why!, /no primary key/);
  // The engine's word is first: no writes, or types the plugin doesn't know.
  assert.match(rulesFor({ name: "orders", kind: "table", primary_key: ["id"] }, pg, { writes: false }).why!, /takes no writes/);
  const unknown = rulesFor({ name: "deliveries", kind: "table", primary_key: ["id"] }, engineOf("driftdb"), caps);
  assert.deepEqual([unknown.rows, unknown.inserts], [false, false]);
  assert.match(unknown.why!, /doesn't know driftdb's types/);
  // A kind nothing has a name for is read, by the name the helper gave it.
  assert.equal(kindOf("stream").label, "stream");
  assert.equal(rulesFor({ name: "webhook_events", kind: "stream", primary_key: [] }, pg, caps).rows, false);
});

// ---- Filters and order ----

const family = (column: string) => ({ id: "integer", status: "text", paid: "boolean", total: "decimal", meta: "json" })[column] as "integer" | "text" | "boolean" | "decimal" | "json";

test("filters are sent once their value is entered, and as the column reads it", () => {
  const drafts: Draft[] = [
    { id: 1, column: "id", op: ">=", value: "100" },
    { id: 2, column: "status", op: "=", value: "" },
    { id: 3, column: "status", op: "like", value: "ship%" },
    { id: 4, column: "paid", op: "=", value: "true" },
    { id: 5, column: "total", op: "<", value: "12.5" },
    // Just added, nothing entered: it narrows nothing yet.
    { id: 6, column: "status", op: "=" },
    { id: 7, column: "status", op: "is_null" },
    { id: 8, column: "status", op: "not_null", value: "ignored" },
    // Not a number: sent as typed, for the database to refuse.
    { id: 9, column: "id", op: "=", value: "abc" },
  ];
  assert.deepEqual(filtersOf(drafts, family), [
    { column: "id", op: ">=", value: 100 },
    // Entered empty is the empty string, which is not NULL.
    { column: "status", op: "=", value: "" },
    { column: "status", op: "like", value: "ship%" },
    { column: "paid", op: "=", value: true },
    { column: "total", op: "<", value: "12.5" },
    { column: "status", op: "is_null" },
    { column: "status", op: "not_null" },
    { column: "id", op: "=", value: "abc" },
  ]);
});

test("a column is offered the connection's operators that mean something for it", () => {
  const all = ["=", "!=", "<", "<=", ">", ">=", "like", "ilike", "is_null", "not_null"];
  assert.deepEqual(opsFor(all, "text"), all);
  assert.deepEqual(opsFor(all, "integer"), ["=", "!=", "<", "<=", ">", ">=", "is_null", "not_null"]);
  assert.deepEqual(opsFor(all, "json"), ["=", "!=", "is_null", "not_null"]);
  assert.deepEqual(opsFor(all, "boolean"), ["=", "!=", "is_null", "not_null"]);
  // An engine with fewer has fewer; one with none has no filters.
  assert.deepEqual(opsFor(["=", "!=", "like"], "other"), ["=", "!=", "like"]);
  assert.deepEqual(opsFor(["=", "!=", "like"], "integer"), ["=", "!="]);
  assert.deepEqual(opsFor([], "text"), []);
});

test("a heading orders by its column: ascending, descending, then as the table gives them", () => {
  assert.deepEqual(nextOrder([], "id"), [{ column: "id" }]);
  assert.deepEqual(nextOrder([{ column: "id" }], "id"), [{ column: "id", desc: true }]);
  assert.deepEqual(nextOrder([{ column: "id", desc: true }], "id"), []);
  assert.deepEqual(nextOrder([{ column: "id", desc: true }], "status"), [{ column: "status" }]);
});

test("a foreign key jumps to the row it points at, and a NULL one points at nothing", () => {
  const fk = { columns: ["customer_id"], ref_schema: "public", ref_table: "customers", ref_columns: ["id"] };
  assert.deepEqual(jumpFilters(fk, { id: "5001", customer_id: 12 }), [{ id: 1, column: "id", op: "=", value: "12" }]);
  assert.equal(jumpFilters(fk, { id: "5001", customer_id: null }), undefined);
  const two = { columns: ["product_id", "warehouse"], ref_schema: "public", ref_table: "inventory", ref_columns: ["product_id", "warehouse"] };
  assert.deepEqual(
    jumpFilters(two, { product_id: 4, warehouse: "east" })?.map((d) => [d.column, d.value]),
    [
      ["product_id", "4"],
      ["warehouse", "east"],
    ],
  );
});

// ---- The console ----

const SQL = "SELECT 1;\n\nSELECT * FROM orders\n  WHERE status = 'a;b';\n-- only a comment\nUPDATE orders SET note = $$x;y$$ WHERE id = 1";

test("statements end at semicolons, but not the ones in strings, bodies or comments", () => {
  assert.deepEqual(
    split(SQL).map((s) => s.text),
    ["SELECT 1", "SELECT * FROM orders\n  WHERE status = 'a;b'", "-- only a comment\nUPDATE orders SET note = $$x;y$$ WHERE id = 1"],
  );
  assert.deepEqual(split("  \n-- nothing here\n/* nor; here */ ;"), []);
  assert.deepEqual(
    split('SELECT "a;b" FROM t; SELECT \'it\'\'s; fine\'').map((s) => s.text),
    ['SELECT "a;b" FROM t', "SELECT 'it''s; fine'"],
  );
  // Where each is in the text.
  const [first, second] = split(SQL);
  assert.equal(SQL.slice(first.from, first.to), "SELECT 1");
  assert.equal(SQL.slice(second.from, second.to), second.text);
});

test("Run means the statement under the cursor, the one just finished, or the selection", () => {
  const at = (pos: number) => statementAt(SQL, { from: pos, to: pos })?.text;
  assert.equal(at(0), "SELECT 1");
  assert.equal(at(4), "SELECT 1");
  // Just after its semicolon, and in the gap before the next: still the first.
  assert.equal(at(9), "SELECT 1");
  assert.equal(at(10), "SELECT 1");
  // At the next one's first letter, and anywhere inside it.
  assert.equal(at(11), "SELECT * FROM orders\n  WHERE status = 'a;b'");
  assert.equal(at(SQL.indexOf("a;b") + 1), "SELECT * FROM orders\n  WHERE status = 'a;b'");
  assert.match(at(SQL.length)!, /^-- only a comment\nUPDATE/);
  // Before the first statement, it is the first.
  assert.equal(statementAt("\n\n  SELECT 2", { from: 0, to: 0 })?.text, "SELECT 2");
  assert.equal(statementAt("  -- nothing\n", { from: 3, to: 3 }), undefined);
  // A selection is run as it is, with where it starts.
  const from = SQL.indexOf("SELECT * FROM orders");
  const picked = statementAt(SQL, { from: from - 1, to: from + 20 });
  assert.deepEqual(picked, { text: "SELECT * FROM orders", from, to: from + 20 });
  assert.equal(statementAt("SELECT 1; ", { from: 0, to: 10 })?.text, "SELECT 1");
  assert.equal(statementAt("SELECT 1", { from: 2, to: 5 })?.text, "LEC");
});

test("a refused statement's place in the editor is the helper's position, counted from one, in what was sent", () => {
  const text = "SELECT 1;\nSELECT id, emial FROM customers";
  const statement = statementAt(text, { from: text.length, to: text.length })!;
  // "emial" is the twelfth character of the statement, which starts on line 2.
  const at = markAt(statement, statement.text, 12)!;
  assert.equal(text.slice(at, at + 5), "emial");
  assert.equal(lineAndColumn(text, at), "line 2, column 12");
  // Explain sends the statement after a word of the console's own.
  const explained = markAt(statement, `EXPLAIN ${statement.text}`, 20)!;
  assert.equal(text.slice(explained, explained + 5), "emial");
  // A place in the word the console added, or past the end, marks nothing.
  assert.equal(markAt(statement, `EXPLAIN ${statement.text}`, 3), undefined);
  assert.equal(markAt(statement, statement.text, 400), undefined);
  assert.equal(markAt(statement, statement.text, undefined), undefined);
  assert.equal(markAt(statement, statement.text, 0), undefined);
  assert.equal(lineAndColumn("SELECT 1", 0), "line 1, column 1");
});

// ---- What the helper said went wrong ----

// The app hands a helper's refusal over as an error with its code and
// message, and the helper's whole answer in detail (app/src/lib/helper.ts).
const refused = (status: number, error: Record<string, unknown>) => Object.assign(new Error(String(error.message)), { status, code: error.code, detail: { error } });

test("a refusal is read by its code, with the database's place, state and detail", () => {
  // Real answers of berth-database (internal/database/API.md).
  const column = faultOf(refused(400, { code: "query_failed", message: 'Column "emial" does not exist.', hint: 'Perhaps you meant to reference the column "customers.email".', sqlstate: "42703", position: 12 }));
  assert.deepEqual(column, { message: 'Column "emial" does not exist.', code: "query_failed", status: 400, hint: 'Perhaps you meant to reference the column "customers.email".', position: 12, sqlstate: "42703", detail: undefined });
  const duplicate = faultOf(refused(400, { code: "query_failed", message: 'Change 1: Duplicate key value violates unique constraint "orders_pkey".', sqlstate: "23505", detail: "Key (id)=(1001) already exists." }));
  assert.equal(duplicate.detail, "Key (id)=(1001) already exists.");
  assert.equal(duplicate.position, undefined);
  // A timeout is a 400 like any other: only its code says what it is.
  assert.equal(faultOf(refused(400, { code: "timeout", message: "The statement ran longer than 10s and was stopped.", hint: "Narrow it, or add a LIMIT.", sqlstate: "57014" })).code, "timeout");
  assert.equal(faultOf(new Error("the network went away")).message, "the network went away");
  assert.equal(faultOf("plain words").message, "plain words");
});

test("which update is needed is told by the code: the helper's, or the box's", () => {
  const noRoute = faultOf(refused(404, { code: "not_found", message: "There is no such route." }));
  const noToken = faultOf(refused(401, { code: "unauthorized", message: "This route needs the helper's token." }));
  const down = faultOf(refused(503, { code: "db_unavailable", message: "The database could not be opened: connect: connection refused." }));
  const off = faultOf(Object.assign(new Error("database's helper isn't running on devl"), { status: 409, code: "helper_off" }));
  const offline = faultOf(Object.assign(new Error("devl is offline"), { status: 503 }));
  assert.deepEqual([isOldHelper(noRoute), isOldBox(noRoute), lostHelper(noRoute)], [true, false, false]);
  assert.deepEqual([isOldHelper(noToken), isOldBox(noToken), lostHelper(noToken)], [false, true, false]);
  // A database that is down is the database's trouble, not the helper's.
  assert.deepEqual([isOldHelper(down), isOldBox(down), lostHelper(down)], [false, false, false]);
  assert.equal(lostHelper(off), true);
  assert.equal(lostHelper(offline), true);
});

// ---- The lock's clock ----

test("writes count down from when they were turned on, whatever the box's clock reads", () => {
  const asked = 1_000_000;
  // A box seven minutes ahead says writes end 22 minutes from now.
  const ahead = asked + WRITES_FOR_MS + 7 * 60_000;
  const skew = skewOf(ahead, asked);
  assert.equal(skew, 7 * 60_000);
  assert.equal(untilHere(ahead, skew, asked), asked + WRITES_FOR_MS);
  // The same box, read again five minutes later: ten minutes are left.
  assert.equal(untilHere(ahead, skew, asked + 5 * 60_000) - (asked + 5 * 60_000), 10 * 60_000);
  // A box three minutes behind would otherwise show writes ending early.
  const behind = asked + WRITES_FOR_MS - 3 * 60_000;
  assert.equal(untilHere(behind, skewOf(behind, asked), asked), asked + WRITES_FOR_MS);
  // With nothing known of the box, its time is taken as it is, and never
  // as more than fifteen minutes from now.
  assert.equal(untilHere(asked + 4 * 60_000, 0, asked), asked + 4 * 60_000);
  assert.equal(untilHere(asked + 60 * 60_000, 0, asked), asked + WRITES_FOR_MS);
});

test("the history holds statements, newest first, each once, and never past its length", () => {
  let h = remember([], "SELECT 1", 100);
  h = remember(h, "  SELECT 2  ", 200);
  h = remember(h, "SELECT 1", 300);
  assert.deepEqual(h, [
    { sql: "SELECT 1", at: 300 },
    { sql: "SELECT 2", at: 200 },
  ]);
  assert.equal(remember(h, "   ", 400), h);
  assert.equal(remember(h, "SELECT 3", 400, 2).length, 2);
  assert.equal(oneLine("SELECT *\n  FROM orders\n  WHERE id = 1"), "SELECT * FROM orders WHERE id = 1");
  assert.equal(oneLine("x".repeat(200), 10), `${"x".repeat(10)}…`);
});
