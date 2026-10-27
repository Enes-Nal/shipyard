import type { Client } from "@/lib/api";

export type GatewayProvider = "gemini" | "openrouter";

export interface GatewayProviderStatus {
  id: GatewayProvider;
  name: string;
  configured: boolean;
  source?: "stored" | "environment";
}

export interface GatewayStatus {
  enabled: boolean;
  base_url: string;
  auto_model: string;
  providers: GatewayProviderStatus[];
  policy: GatewayPolicy;
}

export interface GatewayPolicy {
  objective: "usage" | "balanced" | "quality";
  providers: Record<GatewayProvider, boolean>;
}

export const gatewayApi = {
  status: (client: Client) => client.laptop<GatewayStatus>("GET", "/v1/gateway"),
  connect: (client: Client, provider: GatewayProvider, apiKey: string) => client.laptop<GatewayStatus>("PUT", `/v1/gateway/providers/${provider}`, { api_key: apiKey }),
  disconnect: (client: Client, provider: GatewayProvider) => client.laptop<GatewayStatus>("DELETE", `/v1/gateway/providers/${provider}`),
  setPolicy: (client: Client, policy: GatewayPolicy) => client.laptop<GatewayStatus>("PUT", "/v1/gateway/policy", policy),
};
