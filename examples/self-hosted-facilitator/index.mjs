import { handleFacilitatorRequest } from "@kaspa-x402/facilitator";
import { createMockDirectModeEnvironment, mockRequestHash, paymentRequiredFor, X402_VERSION } from "../lib/mock-direct-mode.mjs";

const { client, facilitator, server } = createMockDirectModeEnvironment();

const resource = {
  url: "https://api.example.test/download",
  description: "Fixed-price file",
  mimeType: "application/octet-stream",
};
const requestHash = mockRequestHash({
  method: "GET",
  url: resource.url,
  body: null,
});
const payment = await client.createPayment(
  paymentRequiredFor(server, {
    resource,
    amount: "100000",
    scheme: "exact",
  }),
  {
    url: resource.url,
    requestHash,
  },
);

const supported = await handleFacilitatorRequest(facilitator, {
  method: "GET",
  path: "/supported",
});
const verify = await handleFacilitatorRequest(facilitator, {
  method: "POST",
  path: "/verify",
  body: {
    x402Version: X402_VERSION,
    paymentPayload: payment.paymentPayload,
    paymentRequirements: payment.accepted,
    resource,
    requestHash,
  },
});
const settle = await handleFacilitatorRequest(facilitator, {
  method: "POST",
  path: "/settle",
  body: {
    x402Version: X402_VERSION,
    paymentPayload: payment.paymentPayload,
    paymentRequirements: payment.accepted,
    resource,
    requestHash,
  },
});

console.log(
  JSON.stringify(
    {
      supportedKinds: supported.body.kinds.map((kind) => `${kind.scheme}:${kind.network}`),
      verify: verify.body,
      settle: {
        status: settle.status,
        success: settle.body.success,
        transaction: settle.body.transaction,
      },
    },
    null,
    2,
  ),
);
