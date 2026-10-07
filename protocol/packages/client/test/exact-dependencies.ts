import type {
  ExactFundingProvider,
  FundingProvider,
  ExactPaymentAttemptStore,
  ChannelStore,
} from "../src/index.js";
import { restrict } from "../../../test-support/exact-dependencies.js";

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
