# MCP over real HTTP supplement

All three scenario groups passed: 10 actual loopback HTTP requests, two paid MCP handler executions, two genuine signed request authorizations and zero broadcasts.

```sh
node standard/mcp-http.mjs
```

The real `paidMcpToolCall` SDK client receives an unpaid tool challenge, builds authorization through a controlled funding provider using the canonical signed native transaction, submits the paid tool call, reads MCP payment-response metadata and applies settlement. Both directions use serialized JSON-RPC `tools/call` envelopes over actual HTTP POST. The server executes `handlePaidMcpToolCall` and the private support adapter verifies real transaction/request Schnorr signatures.

Three subsequent paid calls retain one handler result. Changed arguments and changed server audience each return `invalid_transaction_state` without a successful payment response or additional handler call. A fresh controlled server then destroys its socket after the first paid result; the identical signed retry returns paid response metadata and settles with one handler execution.

Proof: `mcp-http-report.json` records the three groups, request envelope observations, rejection results, independent counters, archive manifest, vector hash and harness hash. Earlier baseline scripts/reports are preserved.

This is a narrow JSON-RPC HTTP carrier, not full MCP Streamable HTTP transport interoperability certification. Chain acceptance and transaction-origin facts are controlled fixtures. The native signatures are real; no independent/live chain observation, network broadcast, funding, durable restart or production throughput is established. The adapters archive is private source-support, outside the public release dependency set.
