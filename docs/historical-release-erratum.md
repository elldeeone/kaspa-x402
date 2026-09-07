# Alpha.1–10 metadata erratum

This notice corrects how historical Alpha.1–10 release metadata should be interpreted. Their frozen snapshots and lock bytes are preserved.

- Historical schemas can reference dependencies through mutable active `/schemas/` routes. A frozen top-level schema URL alone does not freeze its dependency closure. For reproducible validation, use the schemas from the corresponding historical repository revision and resolve their dependencies within that checkout.
- Historical content locks omit source-provenance fields from their hash projection. A matching lock verifies the covered content, not the excluded source revision or provenance claims. Check provenance independently against the historical repository and package artifacts.
- Historical installation examples using `@alpha` select the current dist-tag, not necessarily that historical release. Use the exact package versions recorded in the historical `packages.json` and retain package integrity evidence.

Alpha.11 uses release-local schema references and the complete metadata hash policy. This notice does not rewrite historical evidence or claim Alpha.11 has been published or deployed.
