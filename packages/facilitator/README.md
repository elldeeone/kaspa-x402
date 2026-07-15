# @kaspa-x402/facilitator

Optional self-hosted facilitator endpoints for `/supported`, `/verify`, and `/settle`.

Status: workspace-private alpha tooling. It is not published on npm and should
not be treated as a hosted production facilitator or settlement service.

This package wraps a configured `DirectModeServer` and exposes the x402 v2 facilitator shape without requiring a hosted third-party service.

`/supported` is capability-aware: exact is omitted when the wrapped server lacks its transaction verifier, and action modes such as `claim` and `refund` are only advertised when explicit action settlers are configured.

Implemented:

- `DirectModeFacilitator.supported()` for x402 v2 `kinds`, `extensions`, and `signers`;
- `DirectModeFacilitator.verify()` for read-only payment validation;
- `DirectModeFacilitator.settle()` for direct-mode settlement through the same replay, idempotency, and atomic commit path as paid HTTP/MCP requests;
- `handleFacilitatorRequest()` for framework-neutral `GET /supported`, `POST /verify`, and `POST /settle` routing;
- optional claim/refund action hooks for operator-specific settlement flows.

Every exact `/verify` or `/settle` request must include the resource server's
independently computed `requestHash`. The facilitator never substitutes the
hash embedded in the payment artifact, because doing so would let the artifact
authorize itself for a different resource. Batch requests may retain the
documented deterministic local fallback.

```ts
import { DirectModeFacilitator, handleFacilitatorRequest } from "@kaspa-x402/facilitator";

const facilitator = new DirectModeFacilitator({
  server: directModeServer,
});

const response = await handleFacilitatorRequest(facilitator, {
  method: "POST",
  path: "/verify",
  body: {
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
    resource: { url: "https://api.example.test/data" },
    requestHash,
  },
});
```

The package does not ship a hosted URL, signer, wallet, RPC client, or database. Production deployments should provide durable server state, authenticated settlement callers, and explicit signer metadata if they advertise signers through `/supported`.

Mainnet facilitator capability fails closed unless `allowMainnet: true` is set
on the facilitator and the wrapped server is also explicitly mainnet-enabled.
Malformed or unknown settlement request networks return `invalid_network`
without being reported as testnet settlements.
