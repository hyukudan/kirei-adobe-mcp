# Premiere CEP panel

The CSXS bundle is deliberately separate from the UXP bundle. It connects only to the daemon's loopback WebSocket endpoint and accepts file grants as opaque IDs; it never accepts a free filesystem path. ExtendScript calls are restricted to `CEP_HANDLER_ALLOWLIST` and pass JSON data to a fixed dispatcher, so user input is never treated as code.
