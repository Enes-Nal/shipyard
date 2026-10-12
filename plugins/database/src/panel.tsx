import { useBoxes, type BerthPluginContext, type WorktreePanelProps } from "@berth/plugin";
import { Badge, Button, HelperBox, Icon, Menu, MenuItem, MenuPopup, MenuTrigger, PickOne, Tip, useHelperState } from "@berth/plugin/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type Connection, database, type Fault, isOldHelper, NO_CAPABILITIES, type Schema } from "./api";
import { Browser } from "./browser";
import { Console } from "./console";
import type { Ctx } from "./context";
import { engineOf } from "./engines/index.ts";
import { useNow, useRead, useVisible } from "./live";
import { Lock, UnlockDialog, type Writes } from "./lock";
import { sourceOf } from "./source.ts";
import { COPY, FaultText, HELPER, Line, Notice, Waiting } from "./ui";

// The Database panel: a worktree's own development database. It reads the
// helper's state on the worktree's box, says so when there is nothing to
// show (the box is offline, the helper is off, installing or failed), and
// otherwise draws the worktree's connection.

export function DatabasePanel({ berth, box, location, worktree, main }: WorktreePanelProps) {
  const [ref, visible] = useVisible<HTMLDivElement>();
  const online = useBoxes().find((b) => b.name === box)?.state === "online";
  const helper = useHelperState(berth, box, visible && online);
  const running = helper.status?.state === "running";
  return (
    <div ref={ref} data-testid="database" data-state={online ? (helper.status?.state ?? "reading") : "offline"} className="@container flex h-full min-h-0 flex-col bg-background text-sm">
      {!online ? (
        <Notice icon="CloudOff" title={`${box} is offline`} body="Database's helper runs on the box, beside the database it reads, so there is nothing to show until the box is back." />
      ) : running ? (
        <Connections berth={berth} box={box} source={sourceOf({ location, worktree, main })} worktree={main ? location : worktree} active={visible} />
      ) : (
        <HelperBox variant="panel" berth={berth} box={box} copy={COPY} testId="database" onAbout={() => berth.openScreen("database")} />
      )}
    </div>
  );
}

interface Scope {
  berth: BerthPluginContext;
  box: string;
  source: string;
  worktree: string;
  active: boolean;
}

// Connections reads the databases the helper knows for the worktree, and
// says why when there is none to show.
function Connections({ berth, box, source, worktree, active }: Scope) {
  const api = useMemo(() => database(berth), [berth]);
  const helper = useHelperState(berth, box, false);
  const refresh = helper.refresh;
  const conns = useRead(() => api.connections(box, source), `${box}\n${source}`, { active, every: 10_000 });
  const onFault = useCallback(
    (fault: Fault) => {
      if (fault.code === "helper_off" || fault.status === 503) refresh();
    },
    [refresh],
  );
  useEffect(() => {
    if (conns.fault) onFault(conns.fault);
  }, [conns.fault, onFault]);
  const pickKey = `connection:${box}/${source}`;
  const [picked, setPicked] = useState(() => berth.storage.get<string>(pickKey, ""));

  if (!conns.data) {
    // The helper answers, and has never heard of db/: it is from before this panel.
    if (conns.fault && isOldHelper(conns.fault)) {
      const s = helper.status;
      return (
        <Notice
          icon="CircleFadingArrowUp"
          title={`Database on ${box} needs updating`}
          body={
            s?.update ? (
              <>
                {box} runs <code>{HELPER}</code> {s.version}, from before it could do this. This plugin carries {s.latest}: open Database, and choose <b>Update to {s.latest}…</b> on {box}'s row.
              </>
            ) : (
              <>
                {box} runs a <code>{HELPER}</code> from before it could do this, and this copy of the plugin carries nothing newer. Update the plugin in Settings → Plugins, then choose <b>Update</b> on {box}'s row in Database.
              </>
            )
          }
          actions={
            <>
              <Button size="sm" onClick={() => berth.openScreen("database")}>
                Open Database
              </Button>
              {!s?.update && (
                <Button size="sm" variant="outline" onClick={() => berth.openSettings("plugins")}>
                  Open Settings → Plugins
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => (refresh(), conns.reload())}>
                Check again
              </Button>
            </>
          }
        />
      );
    }
    return <Waiting fault={conns.fault} onRetry={conns.reload} title={`Couldn't ask ${box} for ${worktree}'s database`} />;
  }
  if (conns.data.length === 0) {
    return (
      <Notice
        icon="table-2"
        title={`No database for ${worktree} yet`}
        body={
          <>
            A service of this worktree that Shipyard starts with a <code>DATABASE_URL</code> or <code>POSTGRES_URL</code> pointing at a Postgres on {box} itself shows here once it has started. One that was already running when Database was turned on needs a restart. A database on another host, or one whose address is a secret reference, is not shown.
          </>
        }
        actions={
          <>
            <Button size="sm" variant="outline" onClick={conns.reload}>
              Look again
            </Button>
            <Button size="sm" variant="ghost" onClick={() => berth.openScreen("database")}>
              Which databases show
            </Button>
          </>
        }
      />
    );
  }
  const conn = conns.data.find((c) => c.id === picked) ?? conns.data[0];
  return (
    <Connected
      key={conn.id}
      scope={{ berth, box, source, worktree, active }}
      api={api}
      conn={conn}
      all={conns.data}
      stale={conns.fault}
      onPick={(id) => {
        setPicked(id);
        berth.storage.set(pickKey, id);
      }}
      onFault={onFault}
      reread={conns.reload}
    />
  );
}

function Connected({ scope, api, conn, all, stale, onPick, onFault, reread }: { scope: Scope; api: ReturnType<typeof database>; conn: Connection; all: Connection[]; stale?: Fault; onPick(id: string): void; onFault(fault: Fault): void; reread(): void }) {
  const { berth, box, source, worktree, active } = scope;
  const engine = useMemo(() => engineOf(conn.engine), [conn.engine]);
  const caps = conn.capabilities ?? NO_CAPABILITIES;
  const [mode, setMode] = useState<"browse" | "console">("browse");
  const [put, setPut] = useState<{ sql: string; n: number }>();

  // The lock: what the helper last said, or what it just answered to this
  // panel until it is read again.
  const [answered, setAnswered] = useState<{ until?: number }>();
  useEffect(() => setAnswered(undefined), [conn.writes_until]);
  const until = answered ? answered.until : conn.writes_until;
  const now = useNow(until !== undefined);
  const on = caps.writes && until !== undefined && until > now;
  const [asking, setAsking] = useState(false);
  const [locking, setLocking] = useState(false);
  // Writes ran out while the panel was open: said once, until the next unlock.
  const [ranOut, setRanOut] = useState(false);
  const was = useRef(on);
  useEffect(() => {
    if (was.current && !on && until !== undefined && until <= Date.now()) setRanOut(true);
    was.current = on;
  }, [on, until]);

  const unlock = async () => {
    const r = await api.writes(box, conn.id, true);
    setRanOut(false);
    setAnswered({ until: r.writes_until });
    reread();
  };
  const lock = async () => {
    setLocking(true);
    try {
      await api.writes(box, conn.id, false);
      setAnswered({});
      reread();
    } catch (err) {
      berth.notify(`Couldn't lock writes to ${conn.database}`, String((err as Error)?.message ?? err));
    } finally {
      setLocking(false);
    }
  };
  const writes: Writes = {
    can: caps.writes,
    on,
    until,
    ask: () => setAsking(true),
    refused: () => {
      setAnswered({});
      reread();
    },
  };

  const schema = useRead<Schema[]>(() => api.schema(box, conn.id), `${box}\n${conn.id}`, { active });
  useEffect(() => {
    if (schema.fault) onFault(schema.fault);
  }, [schema.fault, onFault]);
  const ctx: Ctx = { berth, api, box, source, worktree, conn, caps, engine, writes, active, onFault };
  const where = `${conn.host}${conn.port ? `:${conn.port}` : ""}`;

  return (
    <>
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5" data-testid="database-bar" data-engine={conn.engine}>
        {all.length > 1 ? (
          <Menu>
            <MenuTrigger render={<Button size="sm" variant="outline" className="max-w-64" aria-label={`Database: ${conn.database}, ${engine.name}. Pick another`} data-testid="database-connection" />}>
              <Icon name={engine.icon} className="size-3.5" />
              <span className="truncate">{conn.database}</span>
              <Icon name="ChevronsUpDown" className="size-3 text-muted-foreground" />
            </MenuTrigger>
            <MenuPopup align="start" className="min-w-64">
              {all.map((c) => (
                <MenuItem key={c.id} onClick={() => onPick(c.id)}>
                  <Icon name={engineOf(c.engine).icon} className="size-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{c.database}</span>
                  <span className="ml-3 shrink-0 text-muted-foreground text-xs">
                    {engineOf(c.engine).name}
                    {c.label && ` · ${c.label}`}
                  </span>
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 font-medium" data-testid="database-connection">
            <Icon name={engine.icon} className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{conn.database}</span>
          </span>
        )}
        <Tip label={`${engine.name}${where ? ` at ${where}` : ""}${conn.user ? `, as ${conn.user}` : ""}${conn.label ? `, from ${conn.label}` : ""}`}>
          <Badge variant="outline" size="sm" className="hidden shrink-0 font-normal @lg:inline-flex">
            {engine.name}
          </Badge>
        </Tip>
        <PickOne
          label="Browse the tables, or run SQL"
          value={mode}
          onChange={(v) => setMode(v as "browse" | "console")}
          options={[
            { value: "browse", label: "Tables" },
            { value: "console", label: "Console" },
          ]}
        />
        <span className="ml-auto">
          <Lock writes={writes} now={now} busy={locking} onLock={() => void lock()} />
        </span>
      </div>
      {ranOut && !on && (
        <Line tone="note" testId="database-ran-out" actions={<Button size="xs" variant="ghost" onClick={() => setRanOut(false)}>Dismiss</Button>}>
          Writes locked themselves again: the fifteen minutes ran out. What you staged is still staged.
        </Line>
      )}
      {stale && <Line tone="bad">Couldn't ask {box} again: {stale.message}</Line>}
      {!schema.data || !schema.fresh ? (
        schema.fault ? (
          // The helper has the connection, and the database isn't answering it.
          <Notice
            icon="Unplug"
            title={`Couldn't reach ${conn.database}`}
            body={
              <>
                <FaultText fault={schema.fault} />
                <span className="mt-2 block">
                  {engine.name}
                  {where && ` at ${where}`} isn't answering {box}. If its server or container stopped, start it and try again; if the worktree's services moved to another database, restart them and it shows here.
                </span>
              </>
            }
            actions={
              <Button size="sm" variant="outline" onClick={schema.reload}>
                Try again
              </Button>
            }
          />
        ) : (
          <Waiting />
        )
      ) : (
        <>
          <div className={mode === "browse" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <Browser
              ctx={ctx}
              schemas={schema.data}
              onReload={schema.reload}
              toConsole={(sql) => {
                setPut((p) => ({ sql, n: (p?.n ?? 0) + 1 }));
                setMode("console");
              }}
            />
          </div>
          <div className={mode === "console" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <Console ctx={ctx} schemas={schema.data} put={put} />
          </div>
        </>
      )}
      <UnlockDialog open={asking} conn={conn} engine={engine} box={box} worktree={worktree} onUnlock={unlock} onClose={() => setAsking(false)} />
    </>
  );
}
