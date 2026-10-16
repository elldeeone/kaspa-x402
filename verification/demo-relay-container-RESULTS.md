# Demo relay hosting verification

The actual Docker image and the deployed Cloudflare Worker/Container both passed
the five-group read-only proof on 2026-10-16:

- Unauthorized requests fail closed before container startup.
- Only the authenticated `/rpc` POST route is exposed.
- Destination and RPC method allowlists reject arbitrary requests.
- A connected session reads synced Testnet-10 server information twice.
- Request bodies above 4,259,840 bytes are rejected.

The host uses one named instance, capped at one lite container, with a ten-minute
idle timeout. Its only secret is the transport token. Payment state remains in
the gateway Durable Object. The four public SDK packages are unchanged.

The initial native-container host timed out in local Wrangler orchestration.
The deployed host uses Cloudflare's pinned Container lifecycle library instead;
startup and consecutive RPCs pass on the actual Cloudflare service. Local
Wrangler orchestration on Forge still times out and is not claimed as passing.
The Docker image itself passes directly on Forge. No transaction was submitted
by these read-only tests; the public funded browser payment is a separate proof.

Repeat with `verification/proof-demo-relay-container-e2e.mjs`; see the
[hosting procedure](../infra/demo-pnn-relay/README.md).

The public gateway canary initially failed with Cloudflare error 1042 when the
scheduled Worker called the relay. Enabling `global_fetch_strictly_public`
restored the same bounded transport in that context: real node health, the empty
UTXO snapshot, persisted checkpoint, canary checks and public exact/batch 402
offers passed. The deployed gateway retains the funded head after the config
redeploy. This changes no public SDK package or payment-verification code.
