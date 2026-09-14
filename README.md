# Kaspa x402

Kaspa x402 defines proposed x402 v2 network bindings for native Kaspa payments.
HTTP APIs and MCP tools can charge native KAS for each request. Servers verify
and settle each payment on the Kaspa network.

- Canonical reference for specifications, schemas, vectors, documentation, and
  releases: https://kaspa-x402.org
- Testnet-10 integration gateway: https://demo.kaspa-x402.org
- Browser test client: https://kaspa-x402.org/demo/

## Release status

Kaspa x402 is a v1 release candidate. All components use `kaspa:testnet-10`.

The project blocks mainnet use until it completes the gates in
[docs/mainnet-readiness.md](docs/mainnet-readiness.md). The reference runtimes
use mainnet only if the operator sets `allowMainnet` to true.

Package names, schemas, and field names can change before the stable `1.0.0`
release. RC1 replaces all earlier versions. RC1 runtimes do not read or migrate
channel state from a pre-RC version.

## Payment schemes

The binding defines two x402 schemes:

- `exact`
- `batch-settlement`

### `exact`

The `exact` scheme makes one native KAS transfer for a fixed price.

```json
{
  "scheme": "exact",
  "network": "kaspa:<network>",
  "asset": "KAS",
  "amount": "<sompi>",
  "extra": {
    "binding": "kaspa-exact-v2",
    "profile": "standard-native"
  }
}
```

The scheme has two profiles.

#### `standard-native`

`standard-native` is the default profile for an ordinary KAS payment.

#### `additive`

`additive` is an optional profile. It spends a merchant-owned KIP-10 head and
creates its successor.

The successor value increases by the advertised `amount`. This increase is the
only payment to the merchant. An unpaid offer does not reserve or retire a
KIP-10 head.

### `batch-settlement`

The `batch-settlement` scheme charges a fixed price for each request. The buyer
funds a `kaspa-x402-escrow-v4` covenant and signs vouchers for the requests.

```json
{
  "scheme": "batch-settlement",
  "network": "kaspa:<network>",
  "asset": "KAS",
  "amount": "<fixed per-request sompi>",
  "extra": {
    "binding": "kaspa-escrow-v3",
    "templateId": "kaspa-x402-escrow-v4"
  }
}
```

#### Channel identity

Each channel has a KIP-20 `covenantId`. This ID gives the channel a stable
identity and enforces the transaction lineage of successor UTXOs.

The `covenantId` does not provide a reverse lookup for the current UTXO. Thus,
the runtime also stores the current outpoint.

#### Charges and claims

Each voucher contains a signed ceiling. The ceiling is the total charge for the
lifetime of the channel.

The provider can make a partial claim up to the latest signed ceiling. A top-up
keeps the settled lifetime total. The buyer keeps the timed refund path.

Voucher acceptance records a charge; the merchant receives funds only after an
on-chain claim. Claims must cover their fee and meet output policies. Operators
must collect before the refund window: timeout makes a refund eligible, but does
not automatically execute it or expire a merchant claim. See
[batch collection operations](docs/demo-operations.md#batch-collection-and-refunds).

#### Runtime state

The runtime stores the current outpoint and these values:

| Field | Meaning |
| --- | --- |
| `A` | Charged amount |
| `S` | Claimed amount |
| `T` | Signed ceiling |
| `V` | Current value |
| `R` | Advertised reserve |

The runtime stores a new current outpoint after each covenant transition. After
a restart, it uses the stored state to recover the current outpoint.

#### On-chain output policy

KIP-9 storage mass can make very small on-chain outputs too costly. For some
transaction shapes, it can also make these outputs impossible to construct.

The reference gateway uses a minimum output value of `10000000` sompi. This
minimum also applies to the advertised reserve in a batch successor.

This value is a gateway policy. It is not a universal Kaspa consensus dust
constant. A batch voucher price can be less than this on-chain minimum.

Claim transaction fees decrease the server payout. They do not use more value
from the buyer covenant.

#### Refund locks

For values below the consensus timestamp boundary, a batch refund lock is an
absolute DAA score. The refund becomes eligible only after the chain DAA is
greater than the advertised score.

### Testnet confirmation policy

The reference Testnet-10 deployment requires 30 selected-chain confirmations
for each covenant transition. The runtime uses selected-chain traversal to
count these confirmations.

The runtime stores the accepting-block blue score and the checkpoint blue score
as evidence. It does not subtract these scores to calculate confirmation depth.

The runtime writes removed blocks to the journal before it writes replacement
blocks. It uses verified transaction lineage to recover the current head.

The 30-confirmation rule is a deployment policy. It is not a universal claim
about Kaspa consensus finality.

## Repository contents

- The [`spec/`](spec/) directory contains the Kaspa binding and transport
  profiles. Start with [spec/kaspa-x402-v1.md](spec/kaspa-x402-v1.md).
- The [`schemas/`](schemas/) and [`vectors/`](vectors/) directories contain JSON
  Schemas and conformance vectors. The vectors include negative tests.
- The [`packages/`](packages/) directory contains the TypeScript reference
  packages. These packages support clients, servers, covenants, a self-hosted
  facilitator, and a CLI.
- The [`examples/`](examples/) directory contains mock examples for paid HTTP,
  paid MCP tools, facilitator settlement, and recovery.
- The [`contracts/`](contracts/) directory contains the SilverScript escrow
  covenant source and its fixtures.
- The [`site/`](site/) directory contains the source for the standards website.
- The [`packages/demo-gateway/`](packages/demo-gateway/) directory contains the
  private Cloudflare Worker for the hosted Testnet gateway.

## Verification

CI runs the routine check suite on each pull request. Refer to
[CONTRIBUTING.md](CONTRIBUTING.md) for more information.

The Windows CI job runs workspace tests and offline proofs. On Windows, the
reference adapter syncs payment files but skips directory sync, so these checks
do not establish equivalent crash durability. Private proof files inherit Windows
ACLs; the scripts only enforce owner-only POSIX permissions on other platforms.

Run these commands to do the checks locally:

```sh
npm ci
npm test
npm run validate:schemas
npm run site:build && npm run site:check
node packages/cli/dist/index.js vectors verify
```

The mock examples do not need wallet secrets or node credentials. Run them with
these commands:

```sh
node examples/paid-http-api/index.mjs
node examples/paid-mcp-tool/index.mjs
node examples/self-hosted-facilitator/index.mjs
node examples/recovery/index.mjs
```

`npm run proof:offline` uses mock adapters to test:

- Both `exact` profiles
- Rejection of an `exact` replay
- KIP-10 exact-delta settlement
- Batch-settlement idempotency
- Stale-voucher correction
- Transaction version 1 claim, top-up, and refund artifacts

The live Testnet-10 proof stops if an adapter fails. Refer to
[docs/live-testnet-proof.md](docs/live-testnet-proof.md) for instructions.

## Packages

These public packages are release candidates. Install them with the `@rc` tag
or with an exact version:

```text
@kaspa-x402/core
@kaspa-x402/covenant
@kaspa-x402/client
@kaspa-x402/server
```

These workspaces are private and are available only in this repository:

- `@kaspa-x402/facilitator`
- `@kaspa-x402/cli`
- `@kaspa-x402/demo-gateway`

## Security and review

Read [docs/security-threat-model.md](docs/security-threat-model.md) and
[docs/mainnet-readiness.md](docs/mainnet-readiness.md). Draft specifications,
package names, vectors, and live Testnet proof do not show mainnet readiness.

## Reference specifications

- x402 v2: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
- x402 HTTP v2: https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md
- x402 MCP v2: https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/mcp.md
- x402 exact: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact.md
- x402 batch-settlement: https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md
- Kaspa Toccata documentation: https://github.com/kaspanet/docs/tree/main/content/docs/toccata
