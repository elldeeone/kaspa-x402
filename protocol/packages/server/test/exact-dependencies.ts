import type {
  ExactServerStateStore,
  ServerStateStore,
  ExactServerChainProvider,
  ServerChainProvider,
} from "../src/index.js";
import { restrict } from "../../../test-support/exact-dependencies.js";

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
