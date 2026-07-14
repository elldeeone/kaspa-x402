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
}
