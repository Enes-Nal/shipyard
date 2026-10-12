import { mockAgentDevtools } from "@/lib/mock-devtools";

// The demo's agent browser: the checkout-fix worktree on devl has one open,
// at the default 1920×1080, cast as a drawing of the shop's cart page, with
// two shots for Review. window.__berthMockBrowser.resize("390x844", 3) does
// what an agent's `berthd browser resize` would, and .opened() the event an
// agent's `berthd browser open` sends as its browser starts, for tests and
// screenshots.

interface Size {
  width: number;
  height: number;
  scale: number;
}

let size: Size = { width: 1920, height: 1080, scale: 1 };
const label = (v: Size) => `${v.width}×${v.height}${v.scale !== 1 ? ` @${v.scale}x` : ""}`;

// The drawing is laid out at the page's own width, as the shop's page
// would be (a column at most 1100 wide), and drawn at the page's scale.
const svg = (count: number, v: Size = size) => {
  const vw = v.width;
  const vh = v.height;
  const cw = Math.min(1100, vw - 48);
  const x = Math.round((vw - cw) / 2);
  const narrow = vw < 600;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${vw * v.scale}" height="${vh * v.scale}" viewBox="0 0 ${vw} ${vh}">
<rect width="${vw}" height="${vh}" fill="#f8fafc"/><rect width="${vw}" height="64" fill="#0f172a"/>
<text x="${x}" y="41" font-family="system-ui" font-size="22" fill="#fff">acme shop</text>
<text x="${x}" y="140" font-family="system-ui" font-size="40" font-weight="700" fill="#0f172a">Cart</text>
<rect x="${x}" y="180" width="${Math.min(760, cw)}" height="96" rx="12" fill="#fff" stroke="#e2e8f0"/>
<text x="${x + 24}" y="236" font-family="system-ui" font-size="22" fill="#334155">Ceramic mug × ${count}</text>
<rect x="${x}" y="320" width="${narrow ? cw : 220}" height="56" rx="10" fill="#6366f1"/><text x="${narrow ? x + cw / 2 - 44 : x + 36}" y="356" font-family="system-ui" font-size="22" fill="#fff">Checkout</text>
<text x="${x}" y="440" font-family="system-ui" font-size="${narrow ? 14 : 18}" fill="#64748b">The agent's browser on devl, ${label(v)}</text></svg>`;
};

export const mockShotSvg = () => svg(2);

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

export async function mockScreencast(onValue: (v: unknown) => void, signal?: AbortSignal) {
  for (let i = 1; !signal?.aborted; i++) {
    onValue({ data: b64(svg((i % 3) + 1)), mime: "image/svg+xml", w: size.width, h: size.height, scale: size.scale, url: "http://checkout-fix.shop.devl.localhost:1377/cart" });
    await new Promise((r) => setTimeout(r, 1200));
  }
}

export function browserCall(box: string, method: string, path: string): unknown {
  if (box !== "devl" || !path.includes("/browser/")) return undefined;
  if (method === "GET" && path === "worktrees/shop/checkout-fix/browser/status")
    return {
      running: true,
      text: `open: http://checkout-fix.shop.devl.localhost:1377/cart · ${label(size)} (312 MB)`,
      viewport: size,
      size: label(size),
      status: { url: "http://checkout-fix.shop.devl.localhost:1377/cart", rss_bytes: 312 << 20, viewport: size, size: label(size) },
    };
  if (method === "GET" && path.endsWith("/browser/status")) return { running: false, text: "no browser open; it opens at 1920×1080", viewport: { width: 1920, height: 1080, scale: 1 }, size: "1920×1080" };
  if (method === "GET" && path === "worktrees/shop/checkout-fix/browser/devtools") return mockAgentDevtools;
  if (method === "GET" && path.endsWith("/browser/devtools")) return { running: false, console: [], failures: [] };
  return undefined;
}

let emit: ((e: { type: string; box: string; origin?: string; data?: Record<string, unknown> }) => void) | undefined;

// wireBrowserMock gives the mock its event stream.
export function wireBrowserMock(e: typeof emit) {
  emit = e;
}

if (typeof window !== "undefined") {
  (window as unknown as { __berthMockBrowser: unknown }).__berthMockBrowser = {
    opened() {
      emit?.({ type: "browser.opened", box: "devl", origin: "browser", data: { location: "shop", name: "checkout-fix", path: "/home/me/work/shop-checkout-fix" } });
    },
    resize(wxh: string, scale = 1) {
      const [width, height] = wxh.split("x").map(Number);
      size = { width, height, scale };
    },
  };
}
