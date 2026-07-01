# Self-Hosted Facilitator

Framework-neutral sketch for exposing a self-hosted x402 facilitator over the direct-mode server verifier.

```sh
npm run build
node examples/self-hosted-facilitator/index.mjs
```

```ts
import { DirectModeFacilitator, handleFacilitatorRequest } from "@kaspa-x402/facilitator";

const facilitator = new DirectModeFacilitator({
  server: directModeServer,
  extensions: [],
  signers: {},
});

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const body = request.method === "GET" ? undefined : await request.json();
  const result = await handleFacilitatorRequest(facilitator, {
    method: request.method,
    path: url.pathname,
    body,
  });

  return Response.json(result.body, {
    status: result.status,
    headers: result.headers,
  });
}
```

The same configured server state must back direct mode and facilitator mode if both are enabled for the same resource. Settlement callers should be authenticated before production use.

The runnable script performs:

- `/supported` discovery;
- exact payment creation by the client;
- `/verify` against the self-hosted facilitator;
- `/settle` through the same server state used by direct mode.

This demonstrates facilitator optionality: the facilitator endpoint is an adapter over direct-mode verification and settlement, not a required hosted dependency.
