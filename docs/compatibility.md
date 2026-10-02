# Compatibility

Transport preference and current evidence level by host.

[Back to README](../README.md) · [Architecture & security](architecture-and-security.md)

| Host | Primary transport | Declared fallback | Current evidence |
|---|---|---|---|
| Photoshop | UXP WebSocket | Windows COM STA | production bridge code plus mocks; host matrix not yet certified |
| Premiere Pro | UXP Timeline/Bin bridge | CEP/ExtendScript | validated dispatcher and panel code; several mutations still depend on runtime hooks |
| After Effects | ExtendScript Socket bridge | `aerender` for headless render | real JSX handlers and CLI worker; advanced shape/text APIs remain roadmap |
| Illustrator | versioned allowlisted JSX | experimental UXP panel | vector contracts/builders; UXP and Pathfinder semantics require host certification |

Transport selection is capability-based, not version-string-only. A fallback may be used for transport availability failures; validation, permission, and host-operation errors are not silently rerouted.

No row means “works on every Adobe release.” An operation is `host_verified` only when a real-host fixture confirms its postcondition and recovery behavior on the declared OS/application matrix. See the [Photoshop](photoshop.md), [Premiere Pro](premiere.md), [After Effects](after-effects.md), and [Illustrator](illustrator.md) guides for operation-level status.
