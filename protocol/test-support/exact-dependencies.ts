import type {
  ExactServerStateStore,
  ServerStateStore,
  ExactServerChainProvider,
  ServerChainProvider,
} from "../packages/server/src/types.js";
import type {
  ExactFundingProvider,
  FundingProvider,
  ExactPaymentAttemptStore,
  ChannelStore,
} from "../packages/client/src/types.js";

// Deny accidental batch dependency access, including accesses that optional checks might hide.
function restrict<T extends object>(target: T, allowed: readonly string[]): T {
  return new Proxy(target, {
    get(target, key) {
      if (typeof key === "string" && !allowed.includes(key))
        throw new Error(`unexpected batch dependency: ${key}`);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export function exactServerStore(store: ServerStateStore): ExactServerStateStore {
  return restrict(store, [
    "coordinationScope",
    "coordinationDomain",
    "loadPaymentIdentifier",
    "loadPaymentIdentifierReservation",
    "loadExactPayment",
    "commitExactPayment",
    "registerExactHead",
    "loadExactHead",
    "listExactHeads",
    "selectExactHead",
    "claimExactSettlement",
    "loadExactSettlementAttempt",
    "recordExactSettlementBroadcast",
    "acceptExactSettlement",
    "beginExactHandler",
    "recordExactHandlerResult",
    "markExactHandlerRecoveryRequired",
    "abandonExactSettlement",
    "markExactHeadUnavailable",
    "applyExactHeadLineage",
  ]);
}
export function exactServerChain(chain: ServerChainProvider): ExactServerChainProvider {
  return restrict(chain, ["sendTransaction"]);
}
export function exactClientStore(store: ChannelStore): ExactPaymentAttemptStore {
  return restrict(store, [
    "loadExactPaymentAttempt",
    "loadExactPaymentAttemptByIdentifier",
    "claimExactPaymentAttempt",
    "resolveExactPaymentAttempt",
    "markExactPaymentProviderFinalized",
  ]);
}
export function exactClientFunding(provider: FundingProvider): ExactFundingProvider {
  return restrict(provider, [
    "networkId",
    "sourceKind",
    "getPublicIdentity",
    "payExactTransaction",
    "payHashChainTransaction",
    "claimHashChainGrant",
    "finalizeExactPaymentAttempt",
    "sendTransaction",
  ]);
}
