# CPA quota integration

- Implement an independent OpenChamber integration. Preserve the user's existing OpenCode → Magpie → CPA inference path.
- The requirement is desktop and mobile visibility, not just a desktop extension panel. State precisely which host versions and clients have been verified.
- Do not modify, patch, upgrade, restart, or replace the user's running OpenChamber installation or its bundled OpenCode without separate approval. Build and test locally first.
- Read `docs/COMPATIBILITY.md` and `docs/USAGE.md` before selecting an integration route. OpenChamber main and the released 2.6.1 tag have different quota-extension capabilities despite sharing the SDK version number.
- Prefer the dedicated quota aggregate API over CPA management endpoints. Never require full management credentials when the aggregate endpoint suffices.
- No model calls, account resets, credential operations, automatic account switching, deployment, commits, or pushes unless requested.
- Keep WeChat transcripts, live API payloads, account identifiers, credentials, and databases outside this project and out of tool output. Synthetic fixtures only in the repository.
- Use server-side requests with a fixed configured origin, bounded responses, timeouts, no credential forwarding on redirects, and shared caching. Do not create an arbitrary URL proxy.
- Distinguish unknown data from zero, stale readings from fresh readings, and quota percentages from token/cost estimates. Do not sum independent quota percentages.
- Verify parsing, cache behavior, error handling, and target-host compatibility with focused tests; report actual device verification separately from simulated layout checks.
