# Sustained valid-flow qualification

Run from campaign root: `node hash-chain/stress.mjs > hash-chain/stress.log 2>&1`.

Passed: 128 genuine Schnorr-signed sequential link payments. Both protected GET requests and private grant POST claims traverse actual loopback HTTP. Sixteen sampled successful duplicate payment retries did not repeat protected work.

Independent observations: 128 distinct one-time public keys; 128 protected handler invocations; total head increase 2560000000 sompi; zero broadcasts. Per-link head version/value, transaction ID, public key and callback count are retained in `stress-observations.json`.

Explicit test admission policy: 10000 grants per signed payer per 86400 seconds; 128-link chain. Default durable storage limits (100000 records, 67108864 bytes) stayed below capacity: final live accounting 515 records / 546963 bytes, plus 1025 reserved records / 524288 reserved bytes. No rate/storage backpressure was reached.

`stress-report.json` and the original `report.json` are separate. The completed seven-scenario baseline remains unchanged. Stress uses fresh real issuer SQLite and exported SDK signer/verifier; chain/origin observations are controlled callbacks, not evidence of consensus or live network acceptance. This is bounded sequential throughput, not production concurrency/load or funded spending.
