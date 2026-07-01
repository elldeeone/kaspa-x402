# Self-Hosted Facilitator

Framework-neutral sketch for exposing a self-hosted x402 facilitator over the direct-mode server verifier.

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
