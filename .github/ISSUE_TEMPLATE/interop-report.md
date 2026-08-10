---
name: Interoperability report
about: Report a wire-level or gateway interoperability problem found while testing a client, server, or facilitator against the alpha surface.
labels: ["area:demo", "kind:test"]
---

<!--
Testnet evidence only. Never post private keys, seed phrases, or reusable
unpaid payment headers. See docs/demo-implementer-guide.md for field details.
-->

## Environment

- Package versions or commit hash:
- Gateway URL and UTC timestamp:
- Network and scheme:

## What happened

- Decoded `PAYMENT-REQUIRED` summary:
- Decoded `PAYMENT-SIGNATURE` summary (keys removed):
- HTTP status and public error reason:
- Expected behavior and why (spec/schema reference):

## Evidence

- Transaction id and output index (exact flows):
- Channel id, stable covenant id, active outpoint, voucher ceiling, and
  A/S/T/V/R state (batch flows):
