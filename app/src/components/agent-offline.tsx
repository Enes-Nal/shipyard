import { CheckIcon, CopyIcon, PanelsTopLeftIcon, PlayIcon, RotateCwIcon, SquareTerminalIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Scene } from "@/components/art/scenes";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { type AgentBinary, findAgentBinary, retryConnection, startAgent } from "@/lib/agent-start";
import { plainError } from "@/lib/errors";
import { IS_WINDOWS, thisComputer } from "@/lib/platform";

// Any berth command starts the agent when it is not running.
const START = "berth status";

// How long to wait for a started agent to answer before saying so.
const ANSWER_TIMEOUT = 15_000;

// Connecting is shown until the laptop agent answers. When it is not
// running, the app offers to start it (asking before it installs anything
// that starts at login); without a berth command to run, it says how to
// start it from a terminal. Either way this window connects by itself once
// the agent is up.
export function Connecting({ state, error }: { state: string; error?: string }) {
  if (state === "connecting") {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-background">
        <Empty>
          <EmptyHeader>
            <EmptyMedia>
              <Scene name="lighthouse" />
            </EmptyMedia>
            <EmptyTitle>Finding the Terminal agent…</EmptyTitle>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }
  return <AgentOffline error={error} />;
}

type Phase = { kind: "idle" } | { kind: "starting" } | { kind: "waiting" } | { kind: "failed"; message: string };

function AgentOffline({ error }: { error?: string }) {
  // undefined while looking, null when there is no berth command to run.
  const [binary, setBinary] = useState<AgentBinary | null>();
  const [atLogin, setAtLogin] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    findAgentBinary().then(setBinary, () => setBinary(null));
  }, []);

  // This screen goes away once the agent answers; still here means it did not.
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const t = window.setTimeout(
      () => setPhase({ kind: "failed", message: "The agent started, but Terminal can't reach it on 127.0.0.1:1378. Its log, agent.log in Terminal's state folder, says why." }),
      ANSWER_TIMEOUT,
    );
    return () => window.clearTimeout(t);
  }, [phase.kind]);

  const start = async () => {
    setPhase({ kind: "starting" });
    try {
      await startAgent(atLogin);
      setPhase({ kind: "waiting" });
      retryConnection();
    } catch (err) {
      setPhase({ kind: "failed", message: plainError(err) });
    }
  };

  const busy = phase.kind === "starting" || phase.kind === "waiting";
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background">
      <Empty className="max-w-md">
        <EmptyHeader>
          <EmptyMedia>
            <Scene name="offline" />
          </EmptyMedia>
          <EmptyTitle>The Terminal agent isn't running</EmptyTitle>
          <EmptyDescription>
            {binary === null && IS_WINDOWS
              ? "The native agent isn't available in this Windows build yet. Open a sample workspace to explore Terminal without installing anything."
              : binary === null
              ? "The local helper isn't available to this window yet. Copy the setup command, paste it into a terminal, and this window will connect automatically."
              : "It keeps your boxes connected while this window is closed, and keeps running after you quit Terminal."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {binary === null && (IS_WINDOWS ? <WindowsSample /> : <TerminalCommand />)}
          {binary && (
            <div className="flex w-full flex-col items-center gap-3">
              <Button className="w-full" disabled={busy} onClick={() => void start()}>
                {busy ? <Spinner /> : <PlayIcon />}
                {phase.kind === "starting" ? "Starting the Terminal agent…" : phase.kind === "waiting" ? "Connecting…" : "Start the Terminal agent"}
              </Button>
              <label className="flex w-full items-start gap-2.5 text-left text-body">
                <Checkbox className="mt-0.5" checked={atLogin} disabled={busy} onCheckedChange={(v) => setAtLogin(!!v)} />
                <span>
                  Start at login
                  <span className="block text-muted-foreground text-meta">{thisComputer("Also starts it whenever you log in to this Mac, and restarts it if it stops.")}</span>
                </span>
              </label>
              {phase.kind === "failed" && (
                <p role="alert" className="w-full text-left text-destructive-foreground text-body">
                  {phase.message}
                </p>
              )}
              <details className="w-full text-left text-muted-foreground text-meta">
                <summary className="cursor-default select-none hover:text-foreground">Start it from a terminal instead</summary>
                <div className="mt-2">
                  <TerminalCommand />
                </div>
              </details>
            </div>
          )}
          <Button variant="ghost" size="sm" onClick={() => location.reload()}>
            <RotateCwIcon />
            Retry now
          </Button>
          {error && (
            <details className="w-full text-left text-muted-foreground text-meta">
              <summary className="cursor-default select-none hover:text-foreground">Details</summary>
              <pre className="mt-2 rounded-md bg-muted p-2 font-mono whitespace-pre-wrap">{error}</pre>
              {binary && <p className="mt-2">Terminal starts it with {binary.path}</p>}
            </details>
          )}
        </EmptyContent>
      </Empty>
    </div>
  );
}

function WindowsSample() {
  const open = () => {
    const url = new URL(location.href);
    url.searchParams.set("mock", "1");
    url.searchParams.delete("binary");
    location.assign(url);
  };
  return (
    <div className="flex w-full flex-col items-center gap-2">
      <Button className="w-full" onClick={open}>
        <PanelsTopLeftIcon />
        Open sample workspace
      </Button>
      <p className="text-center text-meta text-muted-foreground">Uses synthetic projects and agents; nothing on this computer is changed.</p>
    </div>
  );
}

function TerminalCommand() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex w-full items-center gap-3 rounded-lg border bg-muted/50 p-2 text-left">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-background text-muted-foreground shadow-sm ring-1 ring-border">
        <SquareTerminalIcon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-body text-foreground">Start from a terminal</span>
        <span className="block text-meta text-muted-foreground">Copy, paste, then return here.</span>
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          await navigator.clipboard?.writeText(START);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Copied" : "Copy command"}
      </Button>
    </div>
  );
}
