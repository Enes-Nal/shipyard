import { useBoxes, type ScreenProps } from "@berth/plugin";
import { Button, Empty, EmptyDescription, EmptyHeader, EmptyTitle, Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle, HelperBox, Icon, ViewHeader } from "@berth/plugin/ui";

import { useVisible } from "./live";
import { COPY, GUIDE, HELPER } from "./ui";

// The Database screen: which boxes run the helper, with the switch for
// each, and which databases show up in a worktree's tab.

export function DatabaseScreen({ berth }: ScreenProps) {
  const boxes = useBoxes();
  const [ref, visible] = useVisible<HTMLDivElement>();
  return (
    <div ref={ref} className="space-y-5" data-testid="database-screen">
      <ViewHeader
        title="Database"
        description="A worktree's own development database: its tables, its rows and a SQL console, read-only until you unlock it."
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
            Database runs as a program on a box, <code>{HELPER}</code>, beside the databases it reads. It is off until you turn it on for a box, and it keeps each database's address on that box.
          </FrameDescription>
        </FrameHeader>
        <FramePanel className="p-0">
          {boxes.length === 0 ? (
            <Empty className="py-10">
              <EmptyHeader>
                <Icon name="Server" className="mx-auto mb-2 size-5 text-muted-foreground" />
                <EmptyTitle>No boxes yet</EmptyTitle>
                <EmptyDescription>Add a box, and Database can be turned on for it here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="divide-y">
              {boxes.map((b) => (
                <HelperBox key={b.name} berth={berth} box={b.name} online={b.state === "online"} active={visible} copy={COPY} testId="database" />
              ))}
            </ul>
          )}
        </FramePanel>
      </Frame>

      <Frame variant="card">
        <FrameHeader>
          <FrameTitle>Which databases show</FrameTitle>
          <FrameDescription>A worktree's Database tab shows the database its own services use, once Shipyard has started one of them.</FrameDescription>
        </FrameHeader>
        <FramePanel>
          <ol className="space-y-3 text-sm">
            <Step n={1} title="Start the app as a service of its worktree">
              With Database on for a box, Shipyard tells it about each service it starts there: the ones under <code>services</code> in the repository's <code>.berth/config.json</code>. A service that was already running needs a restart to be noticed. A server you start by hand in a terminal isn't.
            </Step>
            <Step n={2} title="Its DATABASE_URL or POSTGRES_URL points at a Postgres on the box">
              On the box itself: <code>localhost</code>, <code>127.0.0.1</code> or a Unix socket. That is the worktree's own development database, and the only kind shown. Nothing in the service's environment is changed.
            </Step>
            <Step n={3} title="What doesn't show">
              A database on another host (a shared staging database, a hosted one) is never opened from here. Neither is one whose address is a reference to a secret and not the address itself. Other engines than Postgres don't show yet.
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
