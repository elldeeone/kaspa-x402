# Website release failure modes

Public seams: generated pages and JSON served by the actual site preview; the
browser bundle's quote reader; the existing real-browser demo E2E flow.

- A candidate is falsely labelled published, or npm commands imply availability.
- Stable packages retain the RC dist-tag or SDK networks are confused with demo network.
- SDK version is incorrectly used as the independently deployed gateway version.
- Release notes, documentation pages, assets or fragment links are missing.
- Current SDK examples still describe only RC2; historical evidence is relabelled.
- The new browser accepts an incompatible RC2 covenant quote or enables payment.
- Updating the frontend changes qualified SDK package bytes.

No test sends paid requests, claims a private live grant, deploys services or
changes gateway/backend code. Live probes are bounded public read-only requests.
