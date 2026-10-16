import { KaspaPnnClient, selectPnnChainEvidenceClient,
  type PolicySelectedPnnClient } from "@kaspa-x402/adapters";
import type { GatewayConfig } from "./config.js";

/** Submission URLs form one authority; verification domains are configured separately. */
export function configuredPnnClient(config: GatewayConfig): PolicySelectedPnnClient {
  const options = (endpoints: string[]) => ({ endpoints,
    timeoutMs: config.pnnTimeoutMs, attempts: config.pnnAttempts,
    allowInsecureLoopback: config.allowInsecureLoopback,
    rpcFactory: config.boundedPnnRpcFactory,
    boundedWebSocketFactory: config.boundedPnnWebSocketFactory });
  const submission = new KaspaPnnClient(options(config.pnnEndpoints));
  if (config.chainTrustMode === "trusted-single-source")
    return selectPnnChainEvidenceClient({ mode: "trusted-single-source", verification: submission });
  return selectPnnChainEvidenceClient({ mode: "independent-corroboration", submission,
    requiredAuthorities: config.requiredAuthorities,
    authorities:
    config.verificationAuthorities.map((authority) => ({
      trustDomain: authority.trustDomain,
      client: new KaspaPnnClient(options(authority.endpoints)),
    })) });
}
