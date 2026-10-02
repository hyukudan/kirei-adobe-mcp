# Security baseline

[Back to README](../README.md) · [Full architecture and security guide](architecture-and-security.md)

The daemon binds only to loopback, validates peer origin/identity, requires challenge-HMAC with a 256-bit local token, caps frames at 8 MiB, and rejects malformed frames. User files enter through scoped grants and are canonicalized after symlink resolution. Arbitrary shell commands, `eval`, interpolated JSX, and client-supplied raw `batchPlay` are outside the security baseline.

Mutations are revision-bound and idempotent. R3/R4 work requires an approval tied to a stored plan hash, exact scope, risk, expiry, and single-use nonce. Cloud egress is disabled by default. See the full guide for the R0–R4 model, artifact integrity, SQLite WAL target design, sagas, and current durability limitations.
