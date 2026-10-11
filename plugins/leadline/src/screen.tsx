import { useBoxes, type BerthPluginContext, type ScreenProps } from "@berth/plugin";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
  Icon,
  Skeleton,
  Spinner,
  ViewHeader,
  cn,
} from "@berth/plugin/ui";
import { useMemo, useState } from "react";

import { leadline } from "./api";
import { ago, bytes, count, plural, span } from "./format.ts";
import { readHelper, turnOff, turnOn, useHelper, useLive, useVisible } from "./live";
import { Command, HELPER, TurnOnDialog } from "./ui";

// The Leadline screen: which boxes run the helper, with the switch for
// each, what each one has heard from, and what an app needs before it shows
// up at all.

const GUIDE = "https://docs.berthd.app/guides/leadline";

export function LeadlineScreen({ berth }: ScreenProps) {
  const boxes = useBoxes();
  const [ref, visible] = useVisible<HTMLDivElement>();
  return (
    <div ref={ref} className="space-y-5" data-testid="leadline-screen">
      <ViewHeader
        title="Leadline"
        description="What your code did in development: queries, traces and logs, recorded on each box."
        actions={
          <Button size="sm" variant="outline" onClick={() => berth.openUrl(GUIDE)}>
            Guide <Icon name="ArrowUpRight" className="size-3.5" />
          </Button>
        }
      />
      <Frame variant="card">
        <FrameHeader>
          <FrameTitle>Boxes</FrameTitle>
          <FrameDescription>
            Leadline runs as a program on a box, <code>{HELPER}</code>, beside the dev servers it watches. It is off until you turn it on for a box, and what it records stays on that box.
          </FrameDescription>
        </FrameHeader>
        <FramePanel className="p-0">
          {boxes.length === 0 ? (
            <Empty className="py-10">
              <EmptyHeader>
                <Icon name="Server" className="mx-auto mb-2 size-5 text-muted-foreground" />
                <EmptyTitle>No boxes yet</EmptyTitle>
                <EmptyDescription>Add a box, and Leadline can be turned on for it here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="divide-y">
              {boxes.map((b) => (
                <BoxRow key={b.name} berth={berth} box={b.name} online={b.state === "online"} active={visible} />
              ))}
            </ul>
          )}
        </FramePanel>
      </Frame>

      <Frame variant="card">
        <FrameHeader>
          <FrameTitle>When an app sends nothing</FrameTitle>
          <FrameDescription>Leadline shows a worktree once something arrives from it. This is what gets it there.</FrameDescription>
        </FrameHeader>
        <FramePanel>
          <ol className="space-y-3 text-sm">
            <Step n={1} title="Start the app as a service of its worktree">
              With Leadline on for a box, Shipyard sets the variables that point an app at it (<code>OTEL_EXPORTER_OTLP_ENDPOINT</code>, <code>OTEL_SERVICE_NAME</code> and their like) for the services it starts: the ones under <code>services</code> in the repository's <code>.berth/config.json</code>. A service that was already running needs a restart to get them. A server you start by hand in a terminal isn't given them.
            </Step>
            <Step n={2} title="Queries need nothing more">
              When a service's <code>DATABASE_URL</code> or <code>POSTGRES_URL</code> names a Postgres on the box itself, Shipyard routes it through Leadline, which records every statement as it goes by: no SDK, in any language. A database on another machine, or a URL that insists on TLS, is left alone.
            </Step>
            <Step n={3} title="Traces and logs need an OpenTelemetry SDK in the app">
              Any OpenTelemetry SDK reads those variables and sends its traces and logs to Leadline. Without one, Queries still fills in, but Leadline can't tell which request ran a query: Endpoints stays empty and an N+1 goes unflagged.
            </Step>
          </ol>
        </FramePanel>
      </Frame>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground text-xs tabular-nums">{n}</span>
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        <p className="mt-0.5 text-pretty text-muted-foreground [&_code]:text-foreground">{children}</p>
      </div>
    </li>
  );
}

const STATE: Record<string, { label: string; variant: string }> = {
  running: { label: "Running", variant: "success" },
  off: { label: "Off", variant: "outline" },
  none: { label: "Off", variant: "outline" },
  installing: { label: "Installing…", variant: "info" },
  starting: { label: "Starting…", variant: "info" },
  failed: { label: "Failed", variant: "error" },
  unsupported: { label: "Can't run it", variant: "warning" },
};

function BoxRow({ berth, box, online, active }: { berth: BerthPluginContext; box: string; online: boolean; active: boolean }) {
  const view = useHelper(berth, box, active && online);
  const [asking, setAsking] = useState<"on" | "update">();
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const s = view?.status;
  const state = s?.state;
  const running = state === "running";
  const badge = !online ? { label: "Offline", variant: "outline" } : state ? STATE[state] : undefined;

  const off = async () => {
    setBusy(true);
    try {
      await turnOff(berth, box);
    } catch (err) {
      berth.notify(`Couldn't turn Leadline off on ${box}`, String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="px-4 py-3" data-testid="leadline-box" data-box={box} data-state={online ? (state ?? "reading") : "offline"}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Icon name="Server" className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium text-sm">{box}</span>
        {badge ? (
          <Badge variant={badge.variant} size="sm" className="gap-1">
            {(state === "installing" || state === "starting") && <Spinner className="size-3" />}
            {badge.label}
          </Badge>
        ) : view?.old || view?.fault ? (
          <Badge variant="warning" size="sm">
            Unknown
          </Badge>
        ) : (
          <Skeleton className="h-4 w-14" />
        )}
        {s?.version && state !== "none" && (
          <span className="font-mono text-muted-foreground text-xs">
            {HELPER} {s.version}
            {s.platform && ` · ${s.platform}`}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {online && running && s?.update && (
            <Button size="xs" variant="outline" onClick={() => setAsking("update")}>
              Update to {s.latest}…
            </Button>
          )}
          {online && (state === "off" || state === "none") && (
            <Button size="xs" onClick={() => setAsking("on")}>
              Turn on…
            </Button>
          )}
          {online && state === "failed" && (
            <Button size="xs" onClick={() => setAsking("on")}>
              Try again…
            </Button>
          )}
          {online && (running || state === "failed") && (
            <Button size="xs" variant="outline" loading={busy} onClick={() => void off()}>
              Turn off
            </Button>
          )}
          {online && (running || state === "off" || state === "failed") && (
            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setRemoving(true)}>
              Remove data…
            </Button>
          )}
        </span>
      </div>
      <div className="mt-1 pl-7 text-muted-foreground text-xs">
        {!online ? (
          "Its helper can't be reached until the box is back."
        ) : view?.old ? (
          "Shipyard on this computer is older than Leadline needs: its agent can't install a plugin's program on a box yet. Update Shipyard."
        ) : !s ? (
          view?.fault ? (
            <span className="text-destructive-foreground">
              {view.fault.message}{" "}
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => void readHelper(berth, box)}>
                Try again
              </button>
            </span>
          ) : null
        ) : state === "unsupported" ? (
          <>
            {s.error ?? `Its berthd is from before plugins could install a program on a box, or ${HELPER} has no build for ${s.platform || "its platform"}.`} Update the box in{" "}
            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => berth.openSettings("boxes")}>
              Settings → Boxes
            </button>
            .
          </>
        ) : state === "failed" ? (
          <span className="whitespace-pre-wrap text-destructive-foreground">{s.error ?? "The box didn't say why."}</span>
        ) : state === "installing" ? (
          "Downloading the program, checking it against its checksum and handing it to the box."
        ) : state === "starting" ? (
          "The box has it and is starting it."
        ) : state === "off" ? (
          "Nothing is recorded while it is off. What it recorded before is kept on the box. Restart any service that was started while it was on: its database connection went through Leadline."
        ) : state === "none" ? (
          `Turning it on installs ${HELPER} on ${box} and keeps it running there.`
        ) : null}
      </div>
      {online && running && <Heard berth={berth} box={box} active={active} />}
      <TurnOnDialog berth={berth} box={asking ? box : undefined} update={asking === "update"} onClose={() => setAsking(undefined)} />
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove what Leadline recorded on {box}?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops <code>{HELPER}</code> on {box}, removes it, and deletes everything it recorded there: every worktree's queries, traces and logs. It can't be undone. Turn Leadline on again to start afresh.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await turnOff(berth, box, true);
                  setRemoving(false);
                  berth.notify(`Removed Leadline's data on ${box}`);
                } catch (err) {
                  berth.notify(`Couldn't remove Leadline's data on ${box}`, String((err as Error)?.message ?? err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove data
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </li>
  );
}

// Heard is what a running helper holds: how much, for how long, and which
// worktrees it has heard from.
function Heard({ berth, box, active }: { berth: BerthPluginContext; box: string; active: boolean }) {
  const api = useMemo(() => leadline(berth), [berth]);
  const onFault = (fault: { code?: string }) => {
    if (fault.code === "helper_off") void readHelper(berth, box);
  };
  const live = useLive(async () => ({ sources: await api.sources(box), storage: await api.storage(box) }), box, { every: 10_000, active, onFault });
  if (!live.data) return live.fault ? <p className="mt-2 pl-7 text-destructive-foreground text-xs">{live.fault.message}</p> : <Skeleton className="mt-2 ml-7 h-4 w-64" />;
  const { sources, storage } = live.data;
  return (
    <div className="mt-2 pl-7" data-testid="leadline-heard">
      <p className="text-muted-foreground text-xs">
        {bytes(storage.size_bytes)} kept{storage.max_bytes > 0 && ` of ${bytes(storage.max_bytes)} at most`}
        {storage.retain_ms > 0 ? `, for ${span(storage.retain_ms)}` : ", with no time limit"}.{" "}
        {sources.total === 0 ? "No worktree has sent anything yet." : `${plural(sources.total, "worktree")} ${sources.total === 1 ? "has" : "have"} sent something:`}
      </p>
      {sources.sources.length > 0 && (
        <ul className="mt-1.5 divide-y rounded-lg border text-xs">
          {sources.sources.map((src) => (
            <li key={src.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
              <Icon name="GitBranch" className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="font-medium">{src.name}</span>
              {src.services.map((service) => (
                <Command key={service} service={service} />
              ))}
              <span className="text-muted-foreground">{via(src.via)}</span>
              <span className={cn("ml-auto text-muted-foreground tabular-nums")}>
                {count(src.spans)} spans, {count(src.logs)} logs{src.last_seen_ms > 0 && ` · last ${ago(Date.now() - src.last_seen_ms)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function via(v: string[]): string {
  const otlp = v.includes("otlp");
  const proxy = v.includes("postgres-proxy");
  if (otlp && proxy) return "the app's own telemetry, and its Postgres queries off the wire";
  if (otlp) return "the app's own telemetry";
  if (proxy) return "its Postgres queries off the wire";
  return "nothing yet";
}
