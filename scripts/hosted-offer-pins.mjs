import { decodePaymentRequiredHeader } from "@kaspa-x402/core";

export function assertHostedOfferPinned(header, expected) {
  const required = decodePaymentRequiredHeader(header);
  const exact = required.accepts.filter((entry) => entry.scheme === "exact");
  if (exact.length !== 1)
    throw new Error(
      "hosted exact route must advertise exactly one exact offer",
    );
  const accepted = exact[0];
  const resourceUrl = new URL(required.resource.url);
  if (
    new URL(expected.exactUrl).origin !== expected.gatewayOrigin ||
    resourceUrl.origin !== expected.gatewayOrigin ||
    required.resource.url !== expected.exactUrl
  ) {
    throw new Error(
      "hosted exact resource or gateway origin does not match the operator pin",
    );
  }
  if (
    accepted.network !== expected.network ||
    accepted.extra.profile !== expected.profile ||
    accepted.amount !== expected.amount ||
    accepted.payTo !== expected.payTo
  ) {
    throw new Error(
      `hosted exact offer does not match operator pins: ${JSON.stringify({
        network: accepted.network,
        profile: accepted.extra.profile,
        amount: accepted.amount,
        payTo: accepted.payTo,
      })}`,
    );
  }
  if (expected.profile === "additive") {
    const head = expected.head;
    if (
      !head ||
      accepted.extra.headId !== head.headId ||
      accepted.extra.headVersion !== head.version ||
      accepted.extra.headAmount !== head.currentAmount ||
      accepted.extra.headScriptPublicKey !== head.scriptPublicKey ||
      accepted.extra.headRedeemScript !== head.redeemScript ||
      accepted.extra.additiveThresholdSompi !==
        head.additiveThresholdSompi ||
      accepted.extra.expectedHeadOutpoint?.txid !==
        head.currentOutpoint.txid ||
      accepted.extra.expectedHeadOutpoint?.index !== head.currentOutpoint.index
    ) {
      throw new Error(
        "hosted additive offer does not match the freshly registered head snapshot",
      );
    }
  }
}

export function assertHostedSettlementHeadPinned(extension, head) {
  if (
    !extension ||
    extension.exactProfile !== "additive" ||
    extension.headId !== head.headId ||
    extension.headVersion !== head.version ||
    extension.headOutpoint?.txid !== head.currentOutpoint.txid ||
    extension.headOutpoint?.index !== head.currentOutpoint.index
  ) {
    throw new Error(
      "hosted additive settlement does not advance the freshly registered head lineage",
    );
  }
}
