# Compatibilidad inicial

| Host | Transporte primario | Fallback declarado | Estado |
|---|---|---|---|
| Photoshop | UXP WebSocket | COM STA | mock contract |
| Illustrator | UXP WebSocket | ExtendScript allowlisted | mock contract |
| After Effects | ExtendScript Socket Bridge | aerender argv | mock contract |
| Premiere Pro | UXP Timeline/Bin Bridge | CEP/ExtendScript | mock contract |

Los bridges incluidos en esta inicialización no cargan Adobe ni ejecutan scripts; exponen contratos y clientes mock para pruebas sin host abierto.
