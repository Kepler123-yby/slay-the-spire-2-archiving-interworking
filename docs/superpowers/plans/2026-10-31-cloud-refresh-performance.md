# Cloud refresh performance implementation plan

> **For agentic workers:** Use executing-plans to implement in the current checkout.

**Goal:** Reduce repeated cloud requests and Agent startups for save upload and refresh.

**Architecture:** Cache directory IDs and validated immutable publication markers in the Service session. Always list the remote directory, evict missing/changed markers, expire marker entries after 60 seconds, and bypass marker cache before applying a download. In bound mode execute the complete upload/versions operation inside one real Agent worker, returning the session cache with the result.

**Tech stack:** Existing Node.js modules and node:test; no added dependencies.

**Approach:** User authorized the previously proposed caching and operation batching. Cache-only optimization leaves cold Agent startup costs; parallel per-command Agents conflict with the existing runner. Batch operations keep the existing real-host check and sequential cloud protocol.

## Constraints

- Preserve snapshot/marker read-back hashes, manual version selection, backup limits, and game process checks.
- Caches are session-only and invalidated when executor/login changes or an operation fails.
- Desktop performs game recovery and stages a snapshot before dispatch. Workers publish only the exact validated UUID snapshot in the selected scope's outgoing directory; state writes stay under an explicitly allowed state root.
- README remains a usage guide; performance evidence belongs in development documentation.

## Tasks

- [x] Add failing request-count tests for repeated refresh, added/deleted/changed markers, scope separation, expiry and fresh-before-download behavior.
- [x] Implement Service session cache and test cold/warm/new-version command counts.
- [x] Add failing worker/adapter tests for one-task versions/upload, invalid operations and staged snapshot/state path validation.
- [x] Implement the bounded save worker operation and attach/unbind adapter; carry only session cache and preserve direct-host mode.
- [x] Run full unit/UI checks, inspect the diff, build the Windows application and record evidence without touching real saves. See `docs/cloud-performance.md`.
