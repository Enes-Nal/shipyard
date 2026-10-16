import { BugIcon, ClipboardListIcon } from "lucide-react";
import { useState } from "react";

import { AlphaBadge } from "@/components/alpha-badge";
import { HeaderBand, useHeaderPicture } from "@/components/art/header-band";
import { Button } from "@/components/ui/button";
import { copyDiagnostics } from "@/lib/diagnostics";
import { ago, bytes } from "@/lib/format";
import { openDocs, openUrl } from "@/lib/open-url";
import { LINUX_ALPHA, LINUX_BUGS } from "@/lib/platform";
import { NONE, useStore } from "@/lib/store";
import { checkForUpdate, restartToUpdate, updatesSupported, useUpdater } from "@/lib/updater";
import { cn } from "@/lib/utils";
import { useAppVersion } from "@/views/settings/app-version";
import { hasWhatsNew, openWhatsNew } from "@/lib/whats-new";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/views/settings/rows";

const DOCS: [path: string, title: string, what: string][] = [
  ["/concepts/architecture", "How Shipyard works", "The box serves, the laptop connects, and the app is only a view"],
  ["/concepts/security", "Security model", "Identity, pinned mutual TLS, pairing, and where berthd listens"],
  ["/guides/hooks", "Hooks", "Run a command when something happens, or gate an action"],
  ["/reference/events", "Events", "Every event and gate, and what each carries"],
  ["/guides/orchestration", "Orchestration", "Agents driving agents: send, wait, exec, loop"],
  ["/reference/config", "Project config", ".berth/config.json, field by field"],
  ["/guides/task-templates", "Task templates", "Kinds of task you start often, with the agent, branch and prompt filled in"],
  ["/guides/plugins", "Plugins", "Writing plugins"],
  ["/reference/plugin-sdk", "Plugin SDK", "Everything a plugin can call"],
  ["/reference/app-api", "App API", "The API this app uses"],
];

// Hero is the header picture you chose, with the mark and the version on it:
// the one warm thing in Settings. None shows just the mark and version.
function Hero({ version }: { version: string }) {
  const picture = useHeaderPicture();
  const shown = version === "dev" || version === "unknown" || version === "…" ? version : `v${version}`;
  return (
    <div className={cn("relative overflow-hidden rounded-xl border", picture ? "h-40" : "h-auto")}>
      {picture && <HeaderBand picture={picture} position={0.4} fade={0.55} className="absolute inset-0" />}
      <div className={cn("flex items-center gap-3 p-4", picture && "absolute inset-x-0 bottom-0")}>
        <img src={`${import.meta.env.BASE_URL}berth-mark.svg`} alt="" className="size-9 shrink-0 rounded-[9px] shadow-sm" />
        <div className="min-w-0">
          <div className="font-semibold text-base leading-5">Shipyard</div>
          <div className="font-mono text-muted-foreground text-xs">{shown}</div>
        </div>
      </div>
    </div>
  );
}

export function AboutSection() {
  const version = useAppVersion();
  const boxes = useStore((s) => s.status?.boxes ?? NONE);
  const data = useStore((s) => s.boxes);
  const proxy = useStore((s) => s.status?.proxy);

  return (
    <SettingsPage badge={LINUX_ALPHA && <AlphaBadge />} title="About Shipyard" description="Agents on your own boxes, watched from here.">
      <Hero version={version} />
      <SettingsGroup title="Versions">
        <SettingsRow label="App">
          <span className="font-mono text-muted-foreground text-xs">{version}</span>
          {hasWhatsNew() && (
            <Button size="xs" variant="outline" data-testid="about-whats-new" onClick={() => openWhatsNew("about")}>
              What's new
            </Button>
          )}
        </SettingsRow>
        <SettingsRow label="Laptop agent" description="Holds the connection to every box, the private URLs and forwards.">
          <span className="font-mono text-muted-foreground text-xs">127.0.0.1:1378 · proxy :{proxy?.port ?? "-"}</span>
        </SettingsRow>
        {boxes.map((b) => {
          const info = data[b.name]?.info;
          return (
            <SettingsRow key={b.name} label={`berthd on ${b.name}`}>
              <span className="font-mono text-muted-foreground text-xs">{[info?.build && `build ${info.build}`, info?.os && `${info.os}/${info.arch}`, b.state].filter(Boolean).join(" · ")}</span>
            </SettingsRow>
          );
        })}
      </SettingsGroup>
      <UpdatesGroup />
      <HelpGroup />
      <SettingsGroup title="Documentation" description="docs.berthd.app, opened in your browser.">
        <div className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 py-3.5 text-xs">
          {DOCS.map(([path, title, what]) => (
            <div key={path} className="contents">
              <button type="button" onClick={() => void openDocs(path)} className="text-left text-foreground/90 underline-offset-2 hover:underline">
                {title}
              </button>
              <span className="text-muted-foreground">{what}</span>
            </div>
          ))}
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}

// HelpGroup copies what someone helping needs to know, in one paste
// (lib/diagnostics); `berth doctor --report` prints the same.
function HelpGroup() {
  const [busy, setBusy] = useState(false);
  return (
    <SettingsGroup title="Help">
      <SettingsRow
        label="Copy diagnostics"
        description="Versions, berth doctor's checks, the local box and each box, the terminal renderer, theme, Labs, and the last errors and toasts. Tokens, op:// references, emails and your username are taken out."
      >
        <Button
          size="xs"
          variant="outline"
          data-testid="copy-diagnostics"
          loading={busy}
          onClick={() => {
            setBusy(true);
            void copyDiagnostics().finally(() => setBusy(false));
          }}
        >
          <ClipboardListIcon />
          Copy diagnostics
        </Button>
      </SettingsRow>
      {LINUX_ALPHA && (
        <SettingsRow
          label="Report a Linux bug"
          description="The Linux app is an alpha. Tell us what breaks in a GitHub issue on cosscom/shipyard, with your distribution and desktop, and the diagnostics above pasted in."
        >
          <Button size="xs" variant="outline" data-testid="report-linux-bug" onClick={() => void openUrl(LINUX_BUGS)}>
            <BugIcon />
            Report a Linux bug
          </Button>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

const RELEASES = "https://github.com/cosscom/shipyard/releases";

// UpdatesGroup says where the app's own updates stand. Shipyard checks when it
// opens and every few hours, and downloads quietly; the only step left to
// the person is the restart (lib/updater.ts).
function UpdatesGroup() {
  const u = useUpdater();
  if (!updatesSupported()) {
    return (
      <SettingsGroup title="Updates">
        <SettingsRow label="Updates come with the Shipyard app" description="This page is running in a browser, which has nothing to update." />
      </SettingsGroup>
    );
  }
  const busy = u.status === "checking" || u.status === "downloading" || u.status === "installing";
  const checkNow = (
    <Button size="xs" variant="outline" className="min-w-24" loading={u.status === "checking"} disabled={busy} onClick={() => void checkForUpdate({ manual: true })}>
      Check now
    </Button>
  );
  let row;
  switch (u.status) {
    case "ready":
    case "installing":
      row = (
        <SettingsRow label={`Shipyard ${u.version} is ready`} description="Restarting closes and reopens this window. Agents keep running on their boxes.">
          <Button size="xs" variant="ghost" onClick={() => void openUrl(`${RELEASES}/tag/v${u.version}`)}>
            What's new
          </Button>
          <Button size="xs" className="min-w-24" loading={u.status === "installing"} onClick={() => void restartToUpdate()}>
            Restart to update
          </Button>
        </SettingsRow>
      );
      break;
    case "downloading":
      row = (
        <SettingsRow label={`Downloading Shipyard ${u.version}`} description={u.total ? `${bytes(u.received)} of ${bytes(u.total)}` : bytes(u.received)}>
          {checkNow}
        </SettingsRow>
      );
      break;
    case "current":
      row = (
        <SettingsRow label="Shipyard is up to date" description={`Checked ${ago(new Date(u.checkedAt).toISOString())}.`}>
          {checkNow}
        </SettingsRow>
      );
      break;
    case "error":
      row = (
        <SettingsRow label="Couldn't check for updates" description={u.error}>
          {checkNow}
        </SettingsRow>
      );
      break;
    default:
      row = (
        <SettingsRow label={u.status === "checking" ? "Checking for updates…" : "Not checked yet"} description="Shipyard checks when it opens and every few hours.">
          {checkNow}
        </SettingsRow>
      );
  }
  return (
    <SettingsGroup title="Updates" description="New versions download in the background. Shipyard never restarts by itself: it waits for you to choose Restart to update.">
      {row}
    </SettingsGroup>
  );
}
