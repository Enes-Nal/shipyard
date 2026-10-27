import { Clock3Icon, CopyIcon, ExternalLinkIcon, KeyRoundIcon, RouteIcon, ShieldCheckIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { ErrorText } from "@/components/error-note";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import { gatewayApi, type GatewayProvider, type GatewayStatus } from "@/lib/gateway";
import { openUrl } from "@/lib/open-url";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { clearRoutingHistory, useRoutingHistory } from "@/lib/routing-history";
import { providerLabel, type RoutingPolicy, type RoutingProvider } from "@/lib/routing";
import { useStore } from "@/lib/store";
import { Segmented } from "@/views/settings/controls";
import { Code, SettingsGroup, SettingsPage, SettingsRow, Value } from "@/views/settings/rows";

const PROVIDERS: { id: RoutingProvider; agent?: string; detail: string; mode: "wrapped" | "hybrid" | "gateway" | "local" }[] = [
  { id: "codex-subscription", agent: "codex", detail: "Uses your signed-in Codex CLI session. No separate API spend.", mode: "wrapped" },
  { id: "claude-subscription", agent: "claude", detail: "Uses your signed-in Claude Code session. No separate API spend.", mode: "wrapped" },
  { id: "gemini", agent: "gemini", detail: "Uses the signed-in Gemini CLI for threads, or your API key through the local gateway.", mode: "hybrid" },
  { id: "openrouter", detail: "Adds its live model catalog to the local gateway and external Shipkit Auto endpoint.", mode: "gateway" },
  { id: "local", detail: "Custom and third-party CLIs installed on a box.", mode: "local" },
];

export function RoutingSection() {
  const policy = usePrefs((p) => p.routing);
  const boxes = useStore((s) => s.boxes);
  const client = useStore((s) => s.client);
  const [gateway, setGateway] = useState<GatewayStatus>();
  const [gatewayError, setGatewayError] = useState<string>();
  const agents = useMemo(() => {
    const found = new Map<string, { id: string; name: string; models: string[] }>();
    for (const data of Object.values(boxes)) {
      for (const agent of data.info?.agents ?? []) {
        if (!agent.command) continue;
        const previous = found.get(agent.id);
        found.set(agent.id, {
          id: agent.id,
          name: agent.name,
          models: [...new Set([...(previous?.models ?? []), ...(agent.models ?? [])])],
        });
      }
    }
    return [...found.values()];
  }, [boxes]);
  const ids = useMemo(() => new Set(agents.map((agent) => agent.id)), [agents]);
  const update = (patch: Partial<RoutingPolicy>) => setPrefs({ routing: { ...policy, ...patch } });
  const setProvider = (provider: RoutingProvider, on: boolean) => update({ providers: { ...policy.providers, [provider]: on } });

  useEffect(() => {
    if (!client) return;
    let live = true;
    const desired = { objective: policy.objective, providers: { gemini: policy.providers.gemini, openrouter: policy.providers.openrouter } };
    gatewayApi
      .status(client)
      .then((status) =>
        status.policy.objective === desired.objective && status.policy.providers.gemini === desired.providers.gemini && status.policy.providers.openrouter === desired.providers.openrouter
          ? status
          : gatewayApi.setPolicy(client, desired),
      )
      .then(
        (status) => live && setGateway(status),
        (err) => live && setGatewayError(errorMessage(err)),
      );
    return () => {
      live = false;
    };
  }, [client, policy.objective, policy.providers.gemini, policy.providers.openrouter]);

  const gatewayProvider = (provider: RoutingProvider) => gateway?.providers.find((item) => item.id === provider);

  return (
    <SettingsPage title="Routing" description="Choose the best coding agent and model when a thread begins. The decision runs locally and stays fixed for that thread.">
      <SettingsGroup>
        <SettingsRow label="Shipkit Auto" description="Make a route when a new thread starts. You can switch to a specific agent in the composer at any time.">
          <Switch checked={policy.automatic} onCheckedChange={(automatic) => update({ automatic })} />
        </SettingsRow>
        <SettingsRow
          label="Optimize for"
          description={
            policy.objective === "usage"
              ? "Prefer a smaller model unless the task's risk calls for more."
              : policy.objective === "quality"
                ? "Move routine work up one capability tier."
                : "Use the least expensive route expected to preserve answer quality."
          }
        >
          <Segmented
            value={policy.objective}
            options={[
              { value: "usage", label: "Usage" },
              { value: "balanced", label: "Balanced" },
              { value: "quality", label: "Quality" },
            ]}
            onChange={(objective) => update({ objective })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Providers" description="Subscription sessions come first. Disabling a provider removes its agents from automatic routing, but never from manual selection.">
        {PROVIDERS.map((provider) => {
          const connected = gatewayProvider(provider.id)?.configured ?? false;
          const found = provider.agent ? ids.has(provider.agent) : provider.id === "local" ? agents.some((agent) => !["codex", "claude", "gemini"].includes(agent.id)) : false;
          const ready = connected || found;
          const badge = connected
            ? "API connected"
            : ready
              ? provider.mode === "wrapped" || provider.mode === "hybrid"
                ? "CLI ready"
                : "Found"
              : provider.mode === "gateway" || provider.mode === "hybrid"
                ? "Not connected"
                : "Not found";
          return (
            <Fragment key={provider.id}>
              <SettingsRow
                label={
                  <span className="flex items-center gap-2">
                    {provider.agent ? <AgentIcon agent={provider.agent} /> : <RouteIcon className="size-3.5 text-muted-foreground" />}
                    {providerLabel(provider.id)}
                    <Badge variant={ready ? "secondary" : "outline"}>{badge}</Badge>
                  </span>
                }
                description={provider.detail}
              >
                <Switch checked={policy.providers[provider.id]} onCheckedChange={(on) => setProvider(provider.id, on)} />
              </SettingsRow>
              {(provider.id === "gemini" || provider.id === "openrouter") && client && gateway && <GatewayCredential provider={provider.id} status={gateway} onStatus={setGateway} />}
            </Fragment>
          );
        })}
        <ErrorText text={gatewayError} className="py-2.5 text-destructive-foreground text-meta" />
      </SettingsGroup>

      <GatewayEndpoint status={gateway} />

      <ModelPolicy agents={agents} policy={policy} update={update} />

      <SettingsGroup title="Fallbacks" description="A provider outage must not silently change the kind of work you approved.">
        <SettingsRow label="Same model, another provider" description="The gateway may retry the exact same model automatically.">
          <Value>Automatic</Value>
        </SettingsRow>
        <SettingsRow label="Different model or agent" description="Shipkit pauses and asks before changing capability, behavior, or subscription.">
          <Value>Ask first</Value>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Privacy and learning">
        <SettingsRow
          label={
            <span className="flex items-center gap-2">
              <ShieldCheckIcon className="size-3.5 text-success-foreground" />
              Local route analysis
            </span>
          }
          description="The task classifier runs on this Mac. Prompts only leave through the coding agent you start. No credentials are stored in app preferences."
        />
        <SettingsRow label="Remember routing decisions" description="Keep the last 30 choices on this Mac so future learning and debugging have an audit trail.">
          <Switch checked={policy.rememberDecisions} onCheckedChange={(rememberDecisions) => update({ rememberDecisions })} />
        </SettingsRow>
      </SettingsGroup>

      <RoutingHistory />
    </SettingsPage>
  );
}

const KEY_PAGES: Record<GatewayProvider, string> = {
  gemini: "https://aistudio.google.com/app/apikey",
  openrouter: "https://openrouter.ai/settings/keys",
};

function GatewayCredential({ provider, status, onStatus }: { provider: GatewayProvider; status: GatewayStatus; onStatus(status: GatewayStatus): void }) {
  const client = useStore((s) => s.client);
  const current = status.providers.find((item) => item.id === provider);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = current?.name ?? providerLabel(provider);

  const run = async (work: () => Promise<GatewayStatus>) => {
    setBusy(true);
    setError(undefined);
    try {
      onStatus(await work());
      setKey("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-border/60 border-t px-3 py-2.5 sm:px-4">
      {current?.configured ? (
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-muted-foreground text-meta">
            <KeyRoundIcon className="me-1.5 inline size-3 align-[-2px]" />
            Key from {current.source === "environment" ? "this Mac's environment" : "Shipkit's private state file"}. Its value is never returned to the app.
          </p>
          {current.source === "environment" ? (
            <Value>Managed by environment</Value>
          ) : (
            <Button size="xs" variant="ghost" disabled={busy || !client} onClick={() => client && void run(() => gatewayApi.disconnect(client, provider))}>
              {busy && <Spinner className="size-3" />}
              Remove
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            size="sm"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={provider === "gemini" ? "AIza…" : "sk-or-v1-…"}
            aria-label={`${name} API key`}
            className="font-mono [&_input::placeholder]:font-sans"
            value={key}
            disabled={busy}
            onChange={(event) => setKey(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && client && key.trim() && void run(() => gatewayApi.connect(client, provider, key.trim()))}
          />
          <div className="flex shrink-0 gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => void openUrl(KEY_PAGES[provider])}>
              <ExternalLinkIcon className="size-3" />
              Get key
            </Button>
            <Button size="xs" className="min-w-20" disabled={busy || !client || !key.trim()} onClick={() => client && void run(() => gatewayApi.connect(client, provider, key.trim()))}>
              {busy && <Spinner className="size-3" />}
              Connect
            </Button>
          </div>
        </div>
      )}
      <ErrorText text={error} className="pt-2 text-destructive-foreground text-meta" />
    </div>
  );
}

function GatewayEndpoint({ status }: { status?: GatewayStatus }) {
  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toastManager.add({ type: "success", title: `Copied ${label}` });
    } catch (err) {
      toastManager.add({ type: "error", title: `Couldn't copy ${label}`, description: errorMessage(err) });
    }
  };
  const openRouter = status?.providers.find((provider) => provider.id === "openrouter")?.configured ?? false;
  const codexConfig = status
    ? `model = "${status.auto_model}"\nmodel_provider = "shipkit"\n\n[model_providers.shipkit]\nname = "Shipkit Auto"\nbase_url = "${status.base_url}"\nenv_key = "SHIPKIT_API_TOKEN"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false`
    : "";
  return (
    <SettingsGroup title="Local gateway" description="An OpenAI-compatible endpoint for coding tools that support a custom base URL and model.">
      <SettingsRow
        label="Endpoint"
        description={status?.enabled ? "Runs on loopback and requires Shipkit's local bearer token. Provider keys stay behind it." : "Connect Gemini or OpenRouter above to make the endpoint available."}
      >
        {status?.enabled ? (
          <Button size="xs" variant="outline" onClick={() => void copy(status.base_url, "gateway endpoint")}>
            <CopyIcon className="size-3" />
            Copy URL
          </Button>
        ) : (
          <Value>Waiting for a provider</Value>
        )}
      </SettingsRow>
      {status?.enabled && (
        <>
          <SettingsRow label={<Code>{status.base_url}</Code>} description="Set this as the tool's OpenAI base URL." />
          <SettingsRow label="Automatic model" description="Select this model in the external tool. Shipkit chooses from the connected live catalogs.">
            <Button size="xs" variant="outline" onClick={() => void copy(status.auto_model, "model name")}>
              <CopyIcon className="size-3" />
              {status.auto_model}
            </Button>
          </SettingsRow>
          <SettingsRow label="API key" description="Use the local app token shown in Developer settings. It authenticates this Mac; it is not a provider key." />
          <SettingsRow
            label="Codex CLI"
            description={openRouter ? "Responses API ready. Add this provider to your user-level Codex config and set SHIPKIT_API_TOKEN to the local app token." : "Connect OpenRouter to enable the Responses API Codex uses."}
          >
            {openRouter ? (
              <Button size="xs" variant="outline" onClick={() => void copy(codexConfig, "Codex configuration")}>
                <CopyIcon className="size-3" />
                Copy config
              </Button>
            ) : (
              <Value>Needs OpenRouter</Value>
            )}
          </SettingsRow>
          <SettingsRow label="Claude Code" description="Wrapped subscription sessions remain the default. A native Anthropic-protocol adapter is the next gateway compatibility step.">
            <Value>Wrapped sessions</Value>
          </SettingsRow>
        </>
      )}
    </SettingsGroup>
  );
}

function ModelPolicy({ agents, policy, update }: { agents: { id: string; name: string; models: string[] }[]; policy: RoutingPolicy; update(patch: Partial<RoutingPolicy>): void }) {
  const withModels = agents.filter((agent) => agent.models.length);
  const setModel = (agent: string, model: string, on: boolean) => {
    const key = `${agent}:${model}`;
    const excluded = new Set(policy.excludedModels);
    if (on) excluded.delete(key);
    else excluded.add(key);
    update({ excludedModels: [...excluded] });
  };
  return (
    <SettingsGroup title="Models" description="An allowlist built from the live model choices advertised by your installed agent CLIs.">
      {withModels.length ? (
        withModels.flatMap((agent) =>
          agent.models.map((model) => (
            <SettingsRow key={`${agent.id}:${model}`} label={<span className="flex items-center gap-2"><AgentIcon agent={agent.id} />{model}</span>} description={`${agent.name} · available to Shipkit Auto`}>
              <Switch checked={!policy.excludedModels.includes(`${agent.id}:${model}`)} onCheckedChange={(on) => setModel(agent.id, model, on)} />
            </SettingsRow>
          )),
        )
      ) : (
        <SettingsRow label="No model catalogs yet" description="Shipkit will use each installed CLI's default until that CLI advertises model choices." />
      )}
    </SettingsGroup>
  );
}

function RoutingHistory() {
  const entries = useRoutingHistory((s) => s.entries);
  return (
    <SettingsGroup
      title="Recent decisions"
      description="Only successful thread starts are recorded."
      actions={
        entries.length ? (
          <Button size="xs" variant="ghost" onClick={clearRoutingHistory}>
            Clear
          </Button>
        ) : undefined
      }
    >
      {entries.length ? (
        entries.slice(0, 8).map((entry) => (
          <SettingsRow
            key={entry.id}
            label={<span className="flex min-w-0 items-center gap-2"><AgentIcon agent={entry.pick.agent} /><span className="truncate">{entry.prompt || "Untitled task"}</span></span>}
            description={`${entry.location} on ${entry.box} · ${new Date(entry.at).toLocaleString()}`}
          >
            <span className="flex items-center gap-1.5 text-muted-foreground text-tag">
              <Clock3Icon className="size-3" />
              {entry.pick.model || "Default"} · {entry.tier}
            </span>
          </SettingsRow>
        ))
      ) : (
        <SettingsRow label="No automatic routes yet" description="The first successful thread started with Shipkit Auto will appear here." />
      )}
    </SettingsGroup>
  );
}
