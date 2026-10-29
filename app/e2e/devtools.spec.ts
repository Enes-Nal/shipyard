import { readFileSync } from "node:fs";

import { type App, expect, mockOnly, test } from "./fixtures";

// The Browser tab's Console and Network drawer. Mock mode has no laptop
// proxy: the stand-in dev server below puts the proxy's own console script
// into the page a Browser tab's frame asks for with ?__berth_devtools=1, as
// the proxy does (internal/proxy/devtools.go), and the mock agent answers
// the proxy's request log (lib/mock-devtools.ts): ten requests, a 500 and a
// 404 among them.

const SCRIPT = readFileSync(new URL("../../internal/proxy/devtools.js", import.meta.url), "utf8");
const PROXIED = /^https?:\/\/[^/]+\.localhost:1377(?:\/|$)/;

// The acme shop's cart. Its errors are dispatched rather than thrown, so the
// test's own check for uncaught errors stays quiet; the script can't tell.
const PAGE = (script: boolean) => `<!doctype html><html><head>${script ? `<script>${SCRIPT}</script>` : ""}<title>Cart · acme</title></head>
<body style="font:15px system-ui"><h1>Cart</h1><p>Ceramic mug × 2</p><button id="pay">Pay</button>
<script>
console.log("cart ready", { items: 2, currency: "EUR" });
console.warn("Image with src /images/mug-ceramic.png has no width or height");
function renderTotal(cart) { try { return cart.summary.total; } catch (e) { return e; } }
const err = renderTotal({});
dispatchEvent(new ErrorEvent("error", { error: err, message: err.message, filename: location.origin + "/src/cart/summary.tsx", lineno: 42, colno: 17 }));
dispatchEvent(new PromiseRejectionEvent("unhandledrejection", { promise: Promise.resolve(), reason: new Error("payment provider timed out") }));
document.getElementById("pay").onclick = () => console.error("checkout failed: 500");
</script></body></html>`;

test.beforeEach(async ({ app }) => {
  await app.context.route(PROXIED, (route) => {
    const flagged = new URL(route.request().url()).searchParams.has("__berth_devtools");
    return route.fulfill({ status: 200, contentType: "text/html", body: PAGE(flagged) });
  });
  await app.open();
});

async function openCart(app: App) {
  await app.openWorktree("devl/checkout-fix");
  await app.page.getByRole("button", { name: "New tab" }).click();
  await app.page.getByRole("option", { name: /New browser tab/ }).click();
  const pane = app.page.locator("[data-testid=browser-pane]:visible");
  const address = pane.getByRole("textbox", { name: "Address" });
  await address.fill("http://checkout-fix.shop.devl.localhost:1377/cart");
  await address.press("Enter");
  await expect(pane.frameLocator("iframe").getByRole("heading", { name: "Cart" })).toBeVisible();
  return pane;
}

test("the drawer shows the page's console and requests, filters them, and sends one to the agent", async ({ app }) => {
  mockOnly();
  const page = app.page;
  const pane = await openCart(app);

  // Two console errors (the uncaught TypeError and the rejection) and two
  // failed requests (the 500 and the 404): the toolbar and the tab say 4.
  await expect(pane.getByTestId("devtools-badge")).toHaveText("4");
  await expect(page.locator("[data-tab-strip] [data-tab]").filter({ hasText: "Browser" }).getByTestId("tab-devtools-badge")).toHaveText("4");
  // Outside the Terminal app there is no Web Inspector to open.
  await expect(pane.getByRole("button", { name: "Inspect" })).toBeDisabled();

  // ⌘⌥I opens the drawer on its Console.
  await page.keyboard.press("Meta+Alt+KeyI");
  const drawer = pane.getByTestId("devtools-drawer");
  await expect(drawer).toBeVisible();
  const rows = drawer.getByTestId("console-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toHaveAttribute("data-level", "log");
  await expect(rows.nth(0)).toContainText('cart ready {items: 2, currency: "EUR"}');
  await expect(rows.nth(1)).toHaveAttribute("data-level", "warn");
  const uncaught = rows.filter({ hasText: "Uncaught TypeError" });
  await expect(uncaught).toContainText("summary.tsx:42");
  await expect(rows.filter({ hasText: "Uncaught (in promise) Error: payment provider timed out" })).toHaveCount(1);

  // A new error while the drawer is open comes in, and counts.
  await pane.frameLocator("iframe").getByRole("button", { name: "Pay" }).click();
  await expect(rows).toHaveCount(5);
  await expect(pane.getByTestId("devtools-badge")).toHaveText("5");

  // Filters: errors only, then text.
  await drawer.getByRole("button", { name: "Errors", exact: true }).click();
  await expect(rows).toHaveCount(3);
  await drawer.getByRole("textbox", { name: "Filter" }).fill("payment");
  await expect(rows).toHaveCount(1);
  await drawer.getByRole("textbox", { name: "Filter" }).fill("");
  await drawer.getByRole("button", { name: "All", exact: true }).click();

  // The stack folds out.
  await uncaught.getByRole("button", { name: "Show the stack" }).click();
  await expect(uncaught.locator("pre")).toContainText("renderTotal");
  await uncaught.getByRole("button", { name: "Hide the stack" }).click();
  await expect(uncaught.locator("pre")).toHaveCount(0);

  // Send to agent: the error, its place and stack, and the page.
  await uncaught.hover();
  await uncaught.getByRole("button", { name: "Send to agent" }).click();
  const sender = drawer.getByTestId("devtools-sender");
  await expect(sender).toContainText("Uncaught TypeError");
  await sender.getByRole("textbox", { name: "A note for the agent" }).fill("It breaks the cart total");
  await sender.getByRole("button", { name: "Send to agent" }).click();
  await expect(page.getByText("Sent to the agent")).toBeVisible();
  await expect(sender).toHaveCount(0);

  // Network: every request, the failed ones marked, and their answers.
  await drawer.getByRole("tab", { name: /Network/ }).click();
  const reqs = drawer.getByTestId("network-row");
  await expect(reqs).toHaveCount(10);
  await expect(drawer.locator("[data-testid=network-row][data-failed=true]")).toHaveCount(2);
  await drawer.getByRole("button", { name: "Failed", exact: true }).click();
  await expect(reqs).toHaveCount(2);
  const checkout = reqs.filter({ hasText: "/api/checkout" });
  await expect(checkout).toContainText("500");
  await expect(checkout).toContainText("POST");
  await expect(checkout).toContainText("182 ms");
  await checkout.click();
  await expect(drawer).toContainText('{"error":"payment provider timed out","code":"PSP_TIMEOUT"}');
  await checkout.getByRole("button", { name: "Send to agent" }).click();
  await expect(drawer.getByTestId("devtools-sender")).toContainText("POST /api/checkout → 500");
  await drawer.getByTestId("devtools-sender").getByRole("button", { name: "Cancel" }).click();

  // Clearing the console leaves the failed requests in the count.
  await drawer.getByRole("tab", { name: /Console/ }).click();
  await drawer.getByRole("button", { name: "Clear" }).click();
  await expect(rows).toHaveCount(0);
  await expect(pane.getByTestId("devtools-badge")).toHaveText("2");

  // ⌘⌥I again closes it; the toolbar button opens it.
  await page.keyboard.press("Meta+Alt+KeyI");
  await expect(drawer).toHaveCount(0);
  await pane.getByTestId("devtools-toggle").click();
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Close the drawer" }).click();
  await expect(drawer).toHaveCount(0);
});

test("a reload starts the console afresh, and a page outside the proxy has no request list", async ({ app }) => {
  mockOnly();
  const pane = await openCart(app);
  await expect(pane.getByTestId("devtools-badge")).toHaveText("4");
  await pane.getByTestId("devtools-toggle").click();
  const rows = pane.getByTestId("console-row");
  await expect(rows).toHaveCount(4);
  await pane.getByRole("button", { name: "Reload" }).click();
  await expect(pane.frameLocator("iframe").getByRole("heading", { name: "Cart" })).toBeVisible();
  // The same four, not eight: a new page's console.
  await expect(rows).toHaveCount(4);

  await app.context.route("http://localhost:4000/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<h1>local</h1>" }));
  const address = pane.getByRole("textbox", { name: "Address" });
  await address.fill("http://localhost:4000/");
  await address.press("Enter");
  await expect(pane.locator("iframe")).toHaveAttribute("src", "http://localhost:4000/");
  await pane.getByTestId("devtools-drawer").getByRole("tab", { name: /Network/ }).click();
  await expect(pane.getByTestId("devtools-network")).toContainText("goes through Terminal's proxy");
});

test("the agent's view has the agent's browser's console and failed requests", async ({ app }) => {
  mockOnly();
  const page = app.page;
  await app.openWorktree("devl/checkout-fix");
  await page.getByRole("button", { name: "New tab" }).click();
  await page.getByRole("option", { name: /New browser tab/ }).click();
  const pane = page.locator("[data-testid=browser-pane]:visible");
  await pane.getByRole("button", { name: /Agent's view/ }).click();
  await pane.getByTestId("devtools-toggle").click();
  const drawer = pane.getByTestId("devtools-drawer");
  await expect(drawer).toContainText("The agent's browser, on its box");
  const rows = drawer.getByTestId("console-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("TypeError: Cannot read properties of undefined (reading 'total')");
  await expect(rows.nth(1)).toContainText("2");
  await drawer.getByRole("tab", { name: /Network/ }).click();
  await expect(drawer.locator("[data-testid=network-row][data-failed=true]")).toHaveCount(2);
  await expect(drawer.getByTestId("network-row").filter({ hasText: "/api/checkout" })).toContainText("500");
});
