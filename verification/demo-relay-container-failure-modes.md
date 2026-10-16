# Demo relay deployment failure modes

- Missing or short transport secrets must fail closed before a container starts.
- Unauthorized requests, arbitrary paths and methods must not start a container.
- All authorized RPC sessions must reach the same container instance.
- The container must run the existing bounded relay, with an explicit node allowlist.
- Invalid destinations, unsupported RPCs and oversized bodies must remain rejected.
- An authenticated connection must identify a synced Testnet-10 node.
- Restarting a transport container must not create or migrate payment state.
- Container startup and node failures must return a bounded 503, without secrets.
- Build output, private credentials and wallet material must not enter the image context.

The deployment proof uses the actual local Worker/container and a public Testnet
node for read-only RPCs. It submits no transactions. The public paid browser
smoke is separate and records its own funded transaction and retry.
