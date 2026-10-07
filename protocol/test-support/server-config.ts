// Shared combined-scheme fixture shape. Test overrides stay small; production uses batch explicitly.
import type {
  BatchServerConfig,
  DirectModeServerConfig,
  ExactServerConfig,
  ServerStateStore,
  ServerChainProvider,
} from "@kaspa-x402/server";
export type ServerTestConfig = ExactServerConfig &
  BatchServerConfig & {
    store: ServerStateStore;
    chainProvider: ServerChainProvider;
  };
export function serverTestConfig(config: ServerTestConfig): DirectModeServerConfig {
  const {
    serverPublicKey,
    templateId,
    minDepositSompi,
    claimReserveSompi,
    refundTimeoutDaa,
    minimumRefundLeadDaa,
    allowRollingRefundTimeoutDaa,
    maximumRefundHorizonDaa,
    voucherVerifier,
    batchPresentationVerifier,
    claimPolicy,
    claimBuilder,
    claimReconciler,
    topUpVerifier,
    ...exact
  } = config;
  const batch: BatchServerConfig = {
    serverPublicKey,
    templateId,
    minDepositSompi,
    claimReserveSompi,
    refundTimeoutDaa,
    minimumRefundLeadDaa,
    allowRollingRefundTimeoutDaa,
    maximumRefundHorizonDaa,
    voucherVerifier,
    batchPresentationVerifier,
    claimPolicy,
    claimBuilder,
    claimReconciler,
    topUpVerifier,
  };
  for (const key of ["templateId", "minimumRefundLeadDaa", "allowRollingRefundTimeoutDaa"] as const) {
    if (batch[key] === undefined) delete batch[key];
  }
  return { ...exact, batch };
}
