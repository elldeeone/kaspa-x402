# SDK network binding

Test the public client/server payment flow, grant issuer, address codec and PNN
policy-selected evidence APIs. Use real loopback WebSocket transport and SDK
signatures, with controlled chain facts; retain a repeatable JSON report.

- Default constructors must reject mainnet before funding or protected work.
- Explicit mainnet configuration must support standard, additive, hash-chain
  and batch profiles, including retry/recovery, in installed public packages.
- A node, address, request, grant or stored receipt on another network must fail
  before disclosure, submission or acceptance.
- All authority wrappers must preserve the selected immutable network.
- Mainnet protected evidence must reject single-source and mixed-network policy.
- Independent authorities must agree; unavailable quorum and disagreement fail
  closed. Operator independence is declared configuration, not proven by fixtures.
- Testnet defaults and the funded Testnet proof runner must keep their semantics.
- Offline proofs never authorize mainnet broadcasts or close operating-policy,
  independent-source or funded validation gates.
