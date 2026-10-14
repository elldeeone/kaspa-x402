# SDK package publication (#35)

Scope: the four public npm SDKs, immutable source preparation, tarball inspection,
fresh consumer installation and publication of those exact approved bytes.
No demo/site build or real registry publication belongs in the proof.

Public seams: npm directory publish/pack, release preparation/inspection CLI,
seven installed SDK entrypoints and the publisher CLI against a loopback registry.

Failure modes, recorded before implementation:

- Existing but stale/substituted dist is accepted for workspace publication.
- A missing client/server subpath export escapes the index-only presence check.
- Mutable checkout source/dist, ignored npm config, caches or execution overrides
  enter a release attributed to an explicitly selected immutable commit.
- Altered manifest/tarball, wrong revision, missing/duplicate packages, unsafe
  archive paths or symlinks reach publication.
- Tarballs change after inspection or a publisher rebuild runs lifecycle code.
- Build or consumer code receives publication credentials.
- Approved tarballs fail to import or typecheck in a consumer without workspace links.
- Registry metadata or downloaded bytes differ from the approved integrity.
- Local protocol verification without Git history stops working.

The expected manifest digest and revision must come from the reviewed CI artifact
or protected approval record. A mutable receipt alone is not an attestation.
