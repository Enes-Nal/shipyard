import { ArrowRightIcon, LaptopIcon, RotateCwIcon, ServerIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { JoinTeamCard } from "@/views/team/team-entry";
import { IS_WINDOWS, thisComputer } from "@/lib/platform";

// WelcomeStep says what Terminal is in a line and offers the quickest way in:
// this Mac as the box, a sample project on it and a first task, in about a
// minute. A remote box is the other choice, one click away. onJoin, when
// given, is the way in for a second computer: its boxes are already set up
// on the first one. local is whether this computer can be a box: undefined
// while asking, then yes or no. On Windows it can be once WSL is set up, so
// a no there says how (reason) and offers to check again (onRecheck).
export function WelcomeStep({
  local,
  reason,
  onRecheck,
  onThisMac,
  onRemote,
  onJoin,
}: {
  local?: boolean;
  reason?: string;
  onRecheck?(): void;
  onThisMac(): void;
  onRemote(): void;
  onJoin?(): void;
}) {
  const wsl = IS_WINDOWS && local === false;
  return (
    <div>
      {/* The title starts where every step's does; the scene (dawn) is the
          page's, above the progress. */}
      <h1 className="text-title">Welcome to Shipyard</h1>
      <p className="mt-2 text-muted-foreground text-subtitle">
        Shipyard runs coding agents on your own machines, each in a worktree of its own, and shows you which need you, which are working and what they built.
      </p>
      <div className="mt-6 flex flex-col gap-2">
        {local !== false && (
          <Way
            primary
            icon={<LaptopIcon />}
            title={thisComputer("Use this Mac")}
            detail={
              IS_WINDOWS
                ? "Agents run in WSL, Windows' built-in Linux, while this PC is awake. Your first agent is about a minute away; add a server whenever you like."
                : thisComputer("Agents run here while this Mac is awake. Your first agent is about a minute away; add a server whenever you like.")
            }
            action={
              <Button autoFocus disabled={local === undefined} onClick={onThisMac}>
                {local === undefined ? <Spinner className="size-3.5" /> : null}
                {thisComputer("Start on this Mac")} <ArrowRightIcon />
              </Button>
            }
          />
        )}
        {wsl && <SetUpWSL reason={reason} onRecheck={onRecheck} />}
        <Way
          primary={local === false && !wsl}
          icon={<ServerIcon />}
          title="Connect a remote box"
          detail={thisComputer("A VPS or dev machine, over your tailnet, SSH or a pairing link. Agents keep going when this Mac sleeps.")}
          action={
            <Button variant={local === false && !wsl ? "default" : "outline"} autoFocus={local === false && !wsl} onClick={onRemote}>
              Connect a box
            </Button>
          }
        />
      </div>
      <JoinTeamCard />
      {onJoin && (
        <Button variant="ghost" className="mt-4 -ml-3 text-muted-foreground" onClick={onJoin}>
          I already use Shipyard on another computer
        </Button>
      )}
    </div>
  );
}

// SetUpWSL is Use this computer on a Windows PC that can't be a box yet:
// agents run in WSL, which takes an administrator and a restart to install,
// so it says what to run and checks again once that's done.
function SetUpWSL({ reason, onRecheck }: { reason?: string; onRecheck?(): void }) {
  const noWSL = !reason || /wsl --install/i.test(reason);
  return (
    <section aria-label="Use this computer" className="rounded-xl border border-foreground/20 bg-card px-4 py-3.5">
      <div className="flex items-center gap-4">
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground [&_svg]:size-4">
          <LaptopIcon />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-row">Use this computer</h2>
          <p className="mt-0.5 text-muted-foreground text-meta">Agents run in WSL, Windows' built-in Linux. Set it up once, then come back here.</p>
        </div>
        <Button autoFocus onClick={onRecheck} disabled={!onRecheck}>
          <RotateCwIcon /> Check again
        </Button>
      </div>
      {noWSL ? (
        <ol className="mt-3 flex list-decimal flex-col gap-1.5 pl-lane text-desc text-muted-foreground">
          <li>
            In PowerShell as administrator, run <code className="rounded bg-muted px-1 font-mono text-foreground">wsl --install -d Ubuntu</code>, then restart Windows.
          </li>
          <li>
            In Ubuntu, run <code className="rounded bg-muted px-1 font-mono text-foreground">bash scripts/setup-wsl.sh</code> from the Shipyard folder. It installs tmux, git and the agent CLIs.
          </li>
        </ol>
      ) : (
        <p className="mt-3 text-desc text-muted-foreground">{reason}</p>
      )}
    </section>
  );
}

function Way({ icon, title, detail, action, primary }: { icon: ReactNode; title: string; detail: string; action: ReactNode; primary?: boolean }) {
  return (
    <section aria-label={title} className={cn("flex items-center gap-4 rounded-xl border px-4 py-3.5", primary ? "border-foreground/20 bg-card" : "bg-card/40")}>
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-row">{title}</h2>
        <p className="mt-0.5 text-muted-foreground text-meta">{detail}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </section>
  );
}
