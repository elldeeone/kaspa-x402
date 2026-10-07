// Synthetic evidence for orchestration tests; no signature or node verification.
import {
  sha256Hex,
  exactRequestAuthorizationId,
  type AcceptedTransactionEvidence,
  type ExactRequestAuthorization,
} from "@kaspa-x402/core";
const CONFIRMATION_THRESHOLD = 30;
const CLIENT_KEY = "22".repeat(32);

export function acceptedChainEvidence(
  transactionId: string,
  confirmationCount = CONFIRMATION_THRESHOLD,
): AcceptedTransactionEvidence {
  const checkpointBlueScore = 1_000n;
  return {
    status: "accepted",
    transactionId: transactionId.toLowerCase(),
    acceptingBlockHash: sha256Hex(`accepting-block:${transactionId.toLowerCase()}`),
    acceptingBlockBlueScore: (checkpointBlueScore - BigInt(confirmationCount) + 1n).toString(),
    confirmationCount,
    checkpoint: {
      blockHash: "ee".repeat(32),
      blueScore: checkpointBlueScore.toString(),
      daaScore: "1000",
    },
  };
}

export function fakeAuthorizationEvidence(authorization: ExactRequestAuthorization) {
  return {
    authorizationId: exactRequestAuthorizationId(authorization),
    digest: authorization.digest,
    inputIndex: authorization.inputIndex,
    publicKey: CLIENT_KEY,
  };
}
