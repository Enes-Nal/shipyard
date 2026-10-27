import { isTauri } from "@/lib/api";

// openUrl opens a link in the default browser: through the shell plugin in
// the app, where window.open would navigate the webview itself.
export async function openUrl(url: string) {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}

// DOCS_URL is Shipkit's documentation site, built from the repository's docs/.
export const DOCS_URL = "https://docs.berthd.app";

// openDocs opens a page of the docs site, by its path ("/guides/plugins").
export const openDocs = (path = "/") => openUrl(DOCS_URL + path);
