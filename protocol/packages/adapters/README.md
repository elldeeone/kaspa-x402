# @kaspa-x402/adapters

Private reference workspace extracted from the demo gateway. It verifies Kaspa
transactions and chain evidence without importing the website, Cloudflare Worker
or gateway storage. Payment rules and transaction serialization are unchanged.

Use the package root for `VerifiedExactTransactionVerifier`, `KaspaRestClient`,
`KaspaPnnClient`, `PnnChainEvidence`, `VerifiedKaspaChainProvider`, exact head and
settlement reconcilers, `NativeAddressCodec`, `NativeVoucherVerifier` and
`ScriptAddressBook`. Use `@kaspa-x402/adapters/native` for address encoding and
Schnorr verification without loading the provider stack.

For PNN payment evidence, choose a trust policy with
`selectPnnChainEvidenceClient`. `trusted-single-source` explicitly trusts one
operator's failover group as the full payment authority. Optional
`independent-corroboration` requires distinct administrative trust domains to
agree on normalized chain reads; several URLs on one `KaspaPnnClient` count as
one authority. Submission can use a separate client. A second node is not
mandatory for Testnet-10. Independent corroboration is strongly recommended
for higher-assurance Testnet-10 deployments; it does not satisfy the project's
mainnet launch gates.
Each authority validates its own selected-chain checkpoint. Matching UTXO and
acceptance facts may come from nearby tips; snapshot DAA scores must be within
100 and the highest verified DAA is returned. A wider gap or conflicting chain
facts rejects the read.

For direct REST integration:

```ts
import { KaspaRestClient, VerifiedExactTransactionVerifier } from "@kaspa-x402/adapters";
import type { ExactTransactionVerificationRequest } from "@kaspa-x402/server";

async function verify(request: ExactTransactionVerificationRequest, trustedRestUrl: string) {
  const verifier = new VerifiedExactTransactionVerifier(new KaspaRestClient(trustedRestUrl));
  return verifier.verifyExactPayment(request);
}
```

The host must derive the request hash and accepted requirements independently
from the actual protected operation. Successful verification alone neither
settles the payment nor authorizes executing the same protected work twice.

For selected-chain PNN evidence, construct `KaspaPnnClient` with explicit
operator-controlled endpoints, select an explicit trust policy, then create a
**new `PnnChainEvidence` per request** with the selected client, a
`ScriptAddressBook`, and an implementation of `PnnEvidenceStore`. The
`PnnChainEvidence` and `PnnBroadcastChainProvider` constructors reject a raw
client at runtime, including one forced through TypeScript with a cast. Raw
clients remain available for policy construction and transaction submission.
The evidence object keeps mutable request-local snapshots. It can serve both
`VerifiedKaspaChainProvider` and exact verification. RPC confirms network ID,
acceptance and selected-chain continuity; it is a trust boundary, not a light client.
The PNN adapter currently requires Testnet-10 and full transaction/UTXO RPC data.
It requires WSS and a transport that caps frames and reassembled messages before
delivery. Node hosts can use `createNodeBoundedPnnWebSocket` from
`@kaspa-x402/adapters/pnn-node` as `boundedWebSocketFactory`. Direct browser and
Worker WebSockets do not expose this limit and therefore fail closed; a Worker
gateway needs a controlled bounded proxy before PNN routes can operate.
An injected `rpcFactory` is also a trusted transport authority and must carry
the `kaspa-x402:bounded-pnn-rpc:v1` symbol to attest to equivalent limits.
Local `ws:`/`http:` node URLs require `allowInsecureLoopback: true` and a literal
`127.0.0.1` or `[::1]` address. REST uses HTTPS by default and rejects redirects.

Implement `PnnEvidenceStore` to persist funding origins, receipts and discovery
checkpoints. Save records atomically, preserve their original funding snapshot,
return detached values, and fail closed on missing/conflicting evidence or failed
writes. Bound retention without discarding evidence needed by unresolved payments.
Gateway storage is one consumer; it is not a dependency of this package.

Tests use mocked REST/RPC responses and an in-memory evidence store. They cover
canonical transaction matching, payer signatures, output accounting, invalid
covenant lineage, missing node data, reorg rejection and adapter recreation.
These tests do not establish funded-network acceptance or crash durability.
