import { ChevronsUpDownIcon, RouteIcon, SlidersHorizontalIcon, SparklesIcon } from "lucide-react";

import { AgentIcon } from "@/components/agent-glyph";
import { Button } from "@/components/ui/button";
import { Menu, MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import type { RouteDecision } from "@/lib/routing";
import { openSettings } from "@/views/settings/open";

export function RoutingControl({ automatic, route, onAutomatic }: { automatic: boolean; route?: RouteDecision; onAutomatic(on: boolean): void }) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="ghost" aria-label={automatic ? `Routing: Auto${route ? `, ${route.headline}` : ""}` : "Routing: Manual"} className={automatic ? "text-warning-foreground" : "text-muted-foreground"} />}>
        {automatic ? <SparklesIcon /> : <RouteIcon />}
        <span>{automatic ? "Auto" : "Manual"}</span>
        <ChevronsUpDownIcon className="opacity-60" />
      </MenuTrigger>
      <MenuPopup align="end" className="w-80">
        <MenuGroup>
          <MenuGroupLabel>Routing</MenuGroupLabel>
          <MenuCheckboxItem variant="switch" checked={automatic} onCheckedChange={onAutomatic}>
            <span className="flex flex-col gap-0.5">
              <span>Choose the route automatically</span>
              <span className="text-muted-foreground text-meta">Runs once when this thread starts</span>
            </span>
          </MenuCheckboxItem>
        </MenuGroup>
        {automatic && route && (
          <div className="mx-1 mt-1 rounded-lg border bg-background/72 px-3 py-2.5">
            <div className="flex items-center gap-2 text-label">
              <AgentIcon agent={route.pick.agent} />
              <span className="font-medium text-foreground">{route.headline}</span>
              <span className="ml-auto rounded-md bg-warning/12 px-1.5 py-0.5 text-warning-foreground text-tag capitalize">{route.tier}</span>
            </div>
            <p className="mt-1.5 text-muted-foreground text-meta">{route.reason}</p>
            <p className="mt-2 text-muted-foreground text-tag">Subscription first · {route.confidence} confidence</p>
          </div>
        )}
        <MenuSeparator />
        <MenuItem onClick={() => openSettings("routing")}>
          <SlidersHorizontalIcon />
          Routing settings…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export function RoutePreview({ route }: { route?: RouteDecision }) {
  if (!route) return null;
  return (
    <div className="mx-1 mt-1 flex items-start gap-2.5 rounded-xl border border-warning/18 bg-warning/6 px-3 py-2.5" data-testid="route-preview">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg bg-warning/12 text-warning-foreground">
        <SparklesIcon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-label">
          <span className="text-warning-foreground">Shipkit Auto</span>
          <span className="text-muted-foreground">chose</span>
          <AgentIcon agent={route.pick.agent} />
          <span className="truncate text-foreground">{route.headline}</span>
        </div>
        <p className="mt-0.5 text-muted-foreground text-meta">{route.reason}</p>
      </div>
    </div>
  );
}
