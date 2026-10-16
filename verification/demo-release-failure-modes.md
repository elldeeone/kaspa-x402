# Demo 1.0.0 release failure modes

Exercise the built Worker (including its SQLite Durable Object), a real bounded
Node relay and WebSocket peer, and the built browser over separate HTTPS origins.
The funded mode uses a real synced Testnet-10 node; no remote deployment.

- Worker config still rejects 1.0.0 or silently serves an older covenant template.
- The paid routes stay disabled despite a configured bounded relay.
- Native Worker WebSockets are falsely labelled bounded.
- Relay allows unauthenticated requests, arbitrary upstream URLs, unknown RPC
  methods, redirects, oversized requests/responses, fragmented oversized frames,
  indefinite operations, or unbounded concurrent work.
- A rich selected-chain query includes unrelated later transaction bodies and
  exceeds the pre-delivery cap after a payment has already been accepted.
  Bound the node-side data window without treating blue-score filtering as
  selected-parent confirmation depth.
- Worker response parsing allocates an unbounded relay body or ignores timeout.
- Fresh v2 head registration fails, or RC2 state is reused as v2 state.
- Browser cannot obtain a quote, claim a grant, sign/broadcast, or get protected
  content over the actual cross-origin gateway path.
- A retry creates a second payment, or cached success bypasses chain selection.
- A payment succeeds only against mocks rather than funded Testnet consensus.
- Demo/frontend changes alter the previously qualified public SDK archives.

Retain machine-readable controlled and funded reports separately. Never record
wallet keys, proxy tokens or private grants in public reports.

A funded repeat reproduced an accepted payment stuck at 503 because V2 `Low`
also carries signature scripts/output bodies. Position counting must use bounded
V1 selected-chain hashes/accepted IDs; rich V2 data uses a node-side blue-score
range filter. Neither filter nor blue-score distance establishes confirmation
depth: count selected-parent positions, pin/recheck the same node checkpoints,
and retain the existing response budgets.
