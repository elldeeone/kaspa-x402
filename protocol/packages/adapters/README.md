# @kaspa-x402/adapters

Private reference workspace extracted from the demo gateway. It verifies Kaspa
transactions and chain evidence without importing the website, Cloudflare Worker
or gateway storage. Payment rules and transaction serialization are unchanged.

Use the package root for `VerifiedExactTransactionVerifier`, `KaspaRestClient`,
`KaspaPnnClient`, `PnnChainEvidence`, `VerifiedKaspaChainProvider`, exact head and
settlement reconcilers, `NativeAddressCodec`, `NativeVoucherVerifier` and
`ScriptAddressBook`. Use `@kaspa-x402/adapters/native` for address encoding and
Schnorr verification without loading the provider stack.

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
operator-controlled endpoints, then create a **new `PnnChainEvidence` per request**
using a `ScriptAddressBook` and an implementation of `PnnEvidenceStore`.
The evidence object keeps mutable request-local snapshots. It can serve both
`VerifiedKaspaChainProvider` and exact verification. RPC confirms network ID,
acceptance and selected-chain continuity; it is a trust boundary, not a light client.
The PNN adapter currently requires Testnet-10 and full transaction/UTXO RPC data.

Implement `PnnEvidenceStore` to persist funding origins, receipts and discovery
checkpoints. Save records atomically, preserve their original funding snapshot,
return detached values, and fail closed on missing/conflicting evidence or failed
writes. Bound retention without discarding evidence needed by unresolved payments.
Gateway storage is one consumer; it is not a dependency of this package.

Tests use mocked REST/RPC responses and an in-memory evidence store. They cover
canonical transaction matching, payer signatures, output accounting, invalid
covenant lineage, missing node data, reorg rejection and adapter recreation.
These tests do not establish funded-network acceptance or crash durability.
