# CAIP `kaspa` Namespace Registration Draft

Status: draft only. Do not open the upstream pull request without explicit
operator approval. Target: fork of `ChainAgnostic/namespaces`, new
`kaspa/` directory containing the three files below. Process note: CASA
review runs community evaluation, then a Last Call of at least two weeks
before acceptance.

---

## File 1: `kaspa/README.md`

```markdown
# Kaspa Namespace

Kaspa is a proof-of-work layer-1 whose blockDAG consensus (GHOSTDAG)
produces blocks at sub-second cadence with native UTXO semantics. It is an
independent chain with its own genesis, transaction format, and address
encoding; it is not a Bitcoin fork and is not covered by the `bip122`
namespace.

- Website: https://kaspa.org
- Reference node: https://github.com/kaspanet/rusty-kaspa
- Network names are defined by the node's canonical `NetworkId` encoding:
  `mainnet`, `testnet-<n>` (numbered testnets such as `testnet-10`),
  `simnet`, and `devnet`.

Profiles in this namespace:

- CAIP-2 (Blockchain ID)
- CAIP-10 (Account ID)
```

## File 2: `kaspa/caip2.md`

```markdown
---
namespace-identifier: kaspa
title: Kaspa Namespace - Chains
author: <operator name/handle>
status: Draft
type: Standard
created: 2026-07-03
requires: CAIP-2
---

# CAIP-2

*For context, see the [CAIP-2][] specification.*

## Rationale

Kaspa's public networks are identified by the canonical network names
defined by the reference node implementation (rusty-kaspa `NetworkId`):
`mainnet` and numbered testnets such as `testnet-10` and `testnet-11`.
These names are unambiguous, stable across node releases, and already used
by node RPC (`getBlockDagInfo` returns `kaspa-<network>` network names),
public explorers, and wallet software. This registration covers the public
networks; the node also defines `simnet` and `devnet` names for private
local networks, which follow the same syntax but name per-deployment
networks rather than unique chains (comparable to local EVM chain ids).

Named references were chosen over genesis-hash references (as used by some
namespaces) because Kaspa's canonical tooling exposes network names rather
than genesis hashes at every API surface, and numbered testnets are
routinely reset and superseded (`testnet-10`, `testnet-11`) while retaining
their names as the coordination handle. The genesis hash for each network
is defined in the reference node source
(`consensus/core/src/config/genesis.rs`) and can disambiguate a network
name if a deployment ever forks; a future profile revision may register
hash-based aliases if cross-fork ambiguity materialises.

## Syntax

The `reference` component is the canonical Kaspa network name:

- `mainnet`
- `testnet-<n>` where `<n>` is the decimal testnet number

The local-network names `simnet` and `devnet` are syntactically valid
references for tooling that needs them, but they identify per-deployment
private networks, not unique chains.

## Resolution Method

Ask a node for its network via RPC: the `getBlockDagInfo` response field
`networkName` returns `kaspa-<reference>` (for example
`kaspa-testnet-10`). A `chain_id` matches a node when
`"kaspa-" + reference == networkName`.

## Test Cases

```
# Kaspa mainnet
kaspa:mainnet

# Kaspa testnet 10 (current public testnet)
kaspa:testnet-10
```

## References

- [Kaspa](https://kaspa.org)
- [rusty-kaspa NetworkId](https://github.com/kaspanet/rusty-kaspa/blob/master/consensus/core/src/network.rs)
- [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/master/CAIPs/caip-2.md)
```

## File 3: `kaspa/caip10.md`

```markdown
---
namespace-identifier: kaspa
title: Kaspa Namespace - Accounts
author: <operator name/handle>
status: Draft
type: Standard
created: 2026-07-03
requires: ["CAIP-2", "CAIP-10"]
---

# CAIP-10

*For context, see the [CAIP-10][] specification.*

## Rationale

Native Kaspa addresses are encoded as `<prefix>:<payload>` where the prefix
names the network (`kaspa` for mainnet, `kaspatest` for testnets,
`kaspasim` for simnet, `kaspadev` for devnet) and the payload is a
base32-encoded version byte plus public key or script hash with a checksum
(a CashAddr-derived encoding). Because CAIP-10 forbids `:` inside the
account address segment, and because the CAIP-2 `chain_id` already
identifies the network, the account address is defined as the address
payload without the native prefix and separator.

## Syntax

`account_address` is the base32 payload of a native Kaspa address (the part
after `<prefix>:`), lowercase, matching `[a-z0-9]{60,120}`.

Round-trip rule: reattach the native prefix implied by the CAIP-2
reference (`mainnet` -> `kaspa`, `testnet-<n>` -> `kaspatest`,
`simnet` -> `kaspasim`, `devnet` -> `kaspadev`) and the `:` separator to
reconstruct the native address, then validate its checksum.

## Test Cases

```
# Mainnet account
# (native: kaspa:qz7ulu...<payload>)
kaspa:mainnet:qz7ulu...<payload>

# Testnet-10 account
# (native: kaspatest:qzg555y76q97h084lk9yhh4u9jtsan69ewezkfkw300dn00pmyjlja58tdpay)
kaspa:testnet-10:qzg555y76q97h084lk9yhh4u9jtsan69ewezkfkw300dn00pmyjlja58tdpay
```

## References

- [Kaspa address encoding (rusty-kaspa)](https://github.com/kaspanet/rusty-kaspa/tree/master/crypto/addresses)
- [CAIP-10](https://github.com/ChainAgnostic/CAIPs/blob/master/CAIPs/caip-10.md)
```

---

## Submission notes (not part of the PR)

- Replace `<operator name/handle>` and the mainnet test-case placeholder
  with a real mainnet address before opening the PR.
- CASA reviewers may push for genesis-hash references; the caip2.md
  rationale anticipates the question and states the position while leaving
  room to add hash aliases. Accept whichever convention they require; the
  x402 submission tracks this decision either way.
- Sequencing: the Kaspa community post (objection window on the identifier
  convention) goes first; this PR follows once the window closes without
  blocking objections; the x402 feature-request issue comes after that.
  Cite the live reference site, the hosted testnet gateway, and the
  community thread as namespace usage and review evidence. Community thread:
  https://kas-smiths.org/t/kaspa-x402-pay-per-request-kas-payments-for-apis-and-ai-agents/15
  (posted 2026-07-03; window closes 2026-07-24; first reply explicitly
  endorsed the identifier convention and asked for the network-to-prefix
  mapping to be explicit, which caip10.md's round-trip rule already covers).
- Cross-reference the x402 feature-request issue in the PR description once
  it exists, and vice versa.
