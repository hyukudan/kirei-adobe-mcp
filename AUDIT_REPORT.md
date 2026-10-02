# Informe de auditoría técnica

## Veredicto

**NO APTO para iniciar todavía la implementación de paneles UXP/CEP reales.**

El monorepo es un buen esqueleto compilable, pero actualmente representa una **prueba de arquitectura basada en mocks**, no una implementación conforme a `SPECS.md`:

- Compilan los 16 componentes y las 24 pruebas unitarias pasan.
- El catálogo contiene exactamente los 36 nombres previstos.
- Existen interfaces razonables para bridges, DTOs comunes, HMAC, locks y jobs.
- Sin embargo, gateway, daemon, políticas, workflows y bridges no forman todavía una cadena funcional o segura.
- Conectar ahora paneles reales permitiría que operaciones destructivas eludieran validación, snapshots, approvals, capabilities e idempotencia.

La mayor preocupación no es que falten funciones, sino que algunos mocks **declaran éxito, snapshot verificado y mutaciones aplicadas sin ejecutarlas ni validarlas**, algo expresamente prohibido por la especificación.

## Hallazgos críticos y altos

### 1. [CRÍTICO] El runtime de producción registra mocks que simulan éxito

El daemon registra directamente los cuatro `*MockBridge` al construirse en [apps/daemon/src/index.ts:18](D:/mcp/adobe-mcp/apps/daemon/src/index.ts:18). Esos bridges:

- Aceptan cualquier comando sin schema de dominio.
- Cambian una revisión en memoria y devuelven `applied`.
- Generan un snapshot con hash de 64 ceros y `verified:true`.
- Devuelven un artefacto de exportación inexistente.

Esto ocurre en [packages/bridge-core/src/index.ts:55](D:/mcp/adobe-mcp/packages/bridge-core/src/index.ts:55), [packages/bridge-core/src/index.ts:56](D:/mcp/adobe-mcp/packages/bridge-core/src/index.ts:56) y [packages/bridge-core/src/index.ts:57](D:/mcp/adobe-mcp/packages/bridge-core/src/index.ts:57).

Contradice directamente:

- “una capacidad ausente produce `UNSUPPORTED_CAPABILITY`; nunca éxito simulado” ([SPECS.md:20](D:/mcp/adobe-mcp/SPECS.md:20));
- verificación real de snapshots y outputs ([SPECS.md:220](D:/mcp/adobe-mcp/SPECS.md:220));
- el criterio “output corrupto no sucede” ([SPECS.md:298](D:/mcp/adobe-mcp/SPECS.md:298)).

**Acción:** separar inequívocamente `MockBridge` del runtime. El daemon real debe iniciar sin bridges y devolver `APP_NOT_RUNNING` o `BRIDGE_UNAVAILABLE` hasta que un panel autenticado se registre.

---

### 2. [CRÍTICO] Gateway y daemon no están conectados y no implementan MCP

El gateway no implementa `initialize`, `tools/list`, `tools/call`, recursos ni negociación MCP. Interpreta el campo JSON-RPC `method` directamente como nombre de herramienta en [apps/gateway/src/index.ts:12](D:/mcp/adobe-mcp/apps/gateway/src/index.ts:12).

Cuando se ejecuta como proceso, usa un daemon ficticio que refleja los parámetros y devuelve `status:"queued"` en [apps/gateway/src/index.ts:21](D:/mcp/adobe-mcp/apps/gateway/src/index.ts:21). No existe IPC gateway–daemon real.

El daemon, después de autenticar, solo contesta a `ping`; no enruta frames RPC, herramientas ni respuestas en [apps/daemon/src/index.ts:22](D:/mcp/adobe-mcp/apps/daemon/src/index.ts:22).

Por tanto, ninguna de las 36 herramientas es funcional de extremo a extremo.

**Acción:** implementar primero el servidor MCP STDIO real y un cliente IPC autenticado hacia el daemon. El stub actual no debe ser ejecutable fuera de tests.

---

### 3. [CRÍTICO] No existe el pipeline obligatorio Plan → Snapshot → Execute → Verify

El gateway hace únicamente:

1. Validación genérica del input.
2. Comprobación estática del riesgo.
3. Reenvío al supuesto daemon.

Esto está concentrado en [apps/gateway/src/index.ts:14](D:/mcp/adobe-mcp/apps/gateway/src/index.ts:14). No se implementan:

- `planId`, hash o expiración;
- diff y estimación de alcance;
- snapshot previo;
- revisión y revalidación del plan;
- locks durante ejecución;
- idempotencia efectiva;
- verificación posterior;
- compensación o rollback;
- invalidación por cambios externos.

Las clases `LockManager` e `IdempotencyStore` existen, pero ningún flujo las utiliza.

**Acción:** construir un orquestador de mutaciones compartido y hacer imposible llamar directamente a `bridge.mutate()` desde una herramienta pública.

---

### 4. [CRÍTICO] El catálogo acepta comandos arbitrarios y targets de otra aplicación

Todas las ediciones comparten:

```ts
commands: z.array(z.record(z.string(), z.unknown()))
```

en [packages/tool-catalog/src/index.ts:8](D:/mcp/adobe-mcp/packages/tool-catalog/src/index.ts:8). Además, `mutate()` y `exportTool()` reciben `_app` pero lo ignoran en [packages/tool-catalog/src/index.ts:14](D:/mcp/adobe-mcp/packages/tool-catalog/src/index.ts:14).

Comprobé dinámicamente que se aceptan:

- `adobe.photoshop.layers.edit` con `target.app = "premiere-pro"` y `{anything:true}`;
- `adobe.photoshop.export` dirigido a After Effects con opciones arbitrarias.

Esto impide garantizar que “cada herramienta tiene schema, handler y contrato”.

También falta validar el output de cada handler: `ToolDefinition.output` existe, pero el gateway devuelve lo recibido del daemon sin parsearlo.

**Acción:** cada herramienta debe tener un input/output Zod específico, comandos discriminados por host, restricción de `target.app` y validación de respuesta antes de escribir en STDOUT.

---

### 5. [CRÍTICO] El modelo de riesgo y approvals es eludible

El catálogo solo contiene riesgos R0, R1 y R2:

- R0: 12 herramientas.
- R1: 5.
- R2: 19.
- R3/R4: 0.

Borrados, sobrescrituras, filtros destructivos y relinks pueden entrar por comandos genéricos clasificados permanentemente como R2. `riskForScope()` existe, pero el gateway nunca lo usa.

Para R3, basta que `approvalToken` sea una cadena no vacía; no se valida firma, plan hash, alcance, riesgo, nonce ni TTL. Esto se observa en [apps/gateway/src/index.ts:14](D:/mcp/adobe-mcp/apps/gateway/src/index.ts:14) y [packages/policy/src/index.ts:25](D:/mcp/adobe-mcp/packages/policy/src/index.ts:25).

R4 queda, por el contrario, permanentemente bloqueado por el gateway, porque pasa `explicitConfirmation=false` cuando el riesgo es R4 y no existe un mecanismo alternativo.

**Acción:** definir un `ApprovalToken` firmado/autenticado y ligado a `planHash + scope + risk + nonce + expiresAt`; derivar el riesgo del contenido concreto de comandos, destino y alcance.

---

### 6. [ALTO] HMAC y handshake no corresponden al protocolo especificado

Existe un schema `BridgeHello`, pero el daemon nunca lo procesa. En su lugar envía `auth.challenge` y espera un objeto manual `auth.prove`, ninguno de los cuales está modelado completamente como JSON-RPC.

Problemas adicionales:

- El token se genera de nuevo en cada arranque y no se guarda en credential store ni rendezvous.
- El gateway no tiene acceso al token.
- `expiresAt` se anuncia pero nunca se comprueba.
- `clientNonce` no se valida contra el schema ni se registra como nonce de un uso.
- No hay rotación ni ACL.
- El origen permitido por defecto es `"null"`, no un plugin ID concreto.
- No hay negociación de app, versión, instance ID, capabilities o límites.
- El HMAC concatena campos variables sin framing o separación de dominio en [packages/protocol/src/index.ts:34](D:/mcp/adobe-mcp/packages/protocol/src/index.ts:34).

**Acción:** diseñar un state machine de handshake único y tipado: challenge → `bridge.hello` → proof/welcome → sesión autenticada. Persistir el secreto mediante abstracción de credential store.

---

### 7. [ALTO] No se aplica el límite de frames y falta backpressure

Aunque existe `assertFrameSize()`, nunca se invoca. El `WebSocketServer` tampoco configura `maxPayload` en [apps/daemon/src/index.ts:18](D:/mcp/adobe-mcp/apps/daemon/src/index.ts:18).

Tampoco existen:

- límite global de 100 requests;
- ocho lecturas por bridge;
- una escritura por documento raíz;
- rate limit o `retryAfterMs`;
- ping cada 10 segundos y transiciones degraded/disconnected;
- cuotas de artefactos.

Un cliente autenticado podría consumir memoria con payloads considerablemente mayores de 8 MiB.

---

### 8. [ALTO] Los schemas no representan los DTOs normativos

[packages/schemas/src/index.ts](D:/mcp/adobe-mcp/packages/schemas/src/index.ts) contiene tipos genéricos `DocumentState`, `Composition`, `Sequence` y `Layer`, pero faltan o están incompletos los DTOs exactos de `SPECS.md`:

- `PsLayer` y `PsDocumentState`;
- `AiBounds`, `AiItem` y `AiDocumentState`;
- `AeLayer`, `AeCompState` y campos de work area;
- `PrClip`, `PrTrack`, marcadores y `PrSequenceState`;
- `PsExport`, `AiExport`, `AeRender` y `PrExport`.

Otros gaps:

- `RationalTime.timebase` admite `"0"`.
- Muchos nombres, strings y arrays no tienen límite.
- `Color.components` no exige cardinalidad según espacio.
- `OperationReceipt` no representa elementos compensables.
- `ArtifactRef` no modela procedencia.
- No hay schema para planes, approvals, grants resueltos, conexión de panel o descriptor completo.

---

### 9. [ALTO] La generación de JSON Schema está rota

`pnpm schemas:check` falla porque `packages/schemas/generated/manifest.json` no existe.

Además:

- `--check` solo comprueba existencia, no compara contenido generado.
- La conversión usa `target: "jsonSchema2019-09"` y después etiqueta el resultado como Draft 2020-12 en [packages/schemas/src/generate.ts:11](D:/mcp/adobe-mcp/packages/schemas/src/generate.ts:11).
- Solo se exportan 12 schemas, no los contratos públicos completos.
- Los schemas de herramientas también se generan como 2019-09 en [packages/tool-catalog/src/index.ts:25](D:/mcp/adobe-mcp/packages/tool-catalog/src/index.ts:25).

**Acción:** generar en un directorio determinista, comparar bytes en `--check` y fallar ante cualquier diff.

---

### 10. [ALTO] Los cuatro adaptadores son placeholders de cuatro líneas

Photoshop, Illustrator, After Effects y Premiere solo heredan `BaseMockBridge`. No implementan:

- UXP, CEP, ExtendScript, COM o `aerender`;
- handlers allowlisted;
- hash de JSX;
- ejecución modal/undo groups;
- chunks y cancelación;
- selección restaurada;
- exportación o verificación real;
- detección de capacidades por versión.

Peor aún, los descriptors anuncian `batch.atomic@1`, `snapshot.create@1` y `export.file@1` sin soporte real en [packages/bridge-core/src/index.ts:63](D:/mcp/adobe-mcp/packages/bridge-core/src/index.ts:63).

También falta `state.write@1`, aunque el catálogo exige esa capability para mutaciones.

---

### 11. [ALTO] El workflow engine solo ordena un DAG

[packages/workflow-engine/src/index.ts](D:/mcp/adobe-mcp/packages/workflow-engine/src/index.ts) detecta duplicados, dependencias y ciclos, pero no implementa:

- argumentos de llamadas públicas;
- JSON Pointer restringido;
- condiciones;
- comprobación de compatibilidad de schemas;
- fan-out máximo;
- ejecución;
- retries;
- compensaciones/saga.

Acepta reintentos negativos y no limita nodos, profundidad o complejidad. La búsqueda repetida de nodos es además cuadrática.

---

### 12. [ALTO] Grants y sandboxing no están integrados

`validateGrantedPath()` opera sobre una ruta libre; no consulta ni valida `grantId`. Ninguna herramienta resuelve grants y el daemon no tiene un almacén de grants.

La canonicalización reduce traversal básico, pero sigue expuesta a TOCTOU: un enlace o directorio puede cambiar entre validación y uso. No hay apertura segura mediante descriptor ni revalidación en el momento de escribir.

El archivo [adobe-mcp.policy.json](D:/mcp/adobe-mcp/adobe-mcp.policy.json) no se carga en gateway o daemon. Además existen dos modelos de configuración desconectados:

- `PolicyConfig` completo en `@adobe-mcp/config`;
- otro `PolicyConfig` reducido en `@adobe-mcp/policy`.

---

### 13. [MEDIO] Jobs, almacenamiento, eventos y observabilidad son solo memoria

`JobStore`:

- permite transiciones inválidas como `queued → succeeded`;
- permite que `patch` cambie el `id`;
- no valida el objeto resultante con Zod;
- no persiste tras reinicio.

No existe SQLite WAL, migraciones, artefactos content-addressed, rendezvous atómico, auditoría append-only ni entrega de eventos al menos una vez.

Observabilidad se limita a serializar un log. No hay métricas, auditoría ni políticas de retención. La redacción tampoco elimina rutas o contenido creativo por defecto.

---

### 14. [MEDIO] Robustez JSON-RPC insuficiente

- `JSON.parse()` queda fuera del manejo de errores en [apps/gateway/src/index.ts:16](D:/mcp/adobe-mcp/apps/gateway/src/index.ts:16), por lo que una línea JSON inválida puede terminar el proceso.
- Todos los errores RPC usan código numérico `500`.
- El schema de respuesta permite simultáneamente `result` y `error`, o ninguno.
- El mensaje original de excepciones se devuelve sin una traducción segura completa.
- No hay timeout ni cancelación de llamadas al daemon.
- No se valida la salida contra el schema declarado.

## Estado de los 16 componentes

| Componente | Estado |
|---|---|
| schemas | Parcial; DTOs comunes y comandos base, faltan contratos normativos |
| protocol | Parcial; primitivas HMAC/frames, handshake y sesión incompletos |
| tool-catalog | 36 nombres correctos; schemas, riesgo y handlers no conformes |
| policy | Prototipo; approvals y grants no seguros ni integrados |
| workflow-engine | Solo validación/topological sort básica |
| bridge-core | Interfaces útiles, implementación únicamente mock |
| bridge-photoshop | Placeholder mock |
| bridge-illustrator | Placeholder mock |
| bridge-aftereffects | Placeholder mock |
| bridge-premiere | Placeholder mock |
| jobs | Store en memoria con state machine incompleto |
| observability | Serialización/redacción básica |
| config | Schema correcto en líneas generales, pero no se carga |
| testkit | Solo fábrica de mocks; no hay suite contractual común real |
| gateway | Router JSON-RPC provisional, no servidor MCP |
| daemon | Skeleton WebSocket/HMAC, sin registro ni routing RPC |

## Resultado de verificaciones

- `pnpm typecheck`: **pasa**, 25 tareas.
- `pnpm test`: **pasa**, 24 tests muy básicos.
- `pnpm build`: **pasa**, 16 componentes.
- `pnpm test:contract`: **pasa**, pero reutiliza los mismos tests unitarios; no es una suite contractual uniforme.
- `pnpm test:e2e`: reporta éxito, pero **no ejecuta pruebas E2E**; únicamente ejecuta nueve builds porque ningún paquete define `test:e2e`.
- `pnpm schemas:check`: **falla**.
- No existen `scripts/`, `fixtures/` ni los cinco directorios de panel previstos.
- El directorio proporcionado no se reconoce como repositorio Git, por lo que no pude evaluar historial, diffs o estado de cambios.

## Próximos pasos recomendados

### P0 — Antes de crear paneles

1. Sustituir los schemas genéricos por los DTOs normativos completos.
2. Crear schemas específicos de input/output para las 36 herramientas.
3. Corregir JSON Schema Draft 2020-12 y su comprobación reproducible.
4. Definir formalmente `Plan`, `ApprovalToken`, grants, descriptors, hello/welcome y errores RPC.
5. Retirar mocks del daemon ejecutable y prohibir éxito simulado.

### P1 — Núcleo seguro

1. Implementar MCP STDIO real en gateway.
2. Implementar IPC gateway–daemon y routing JSON-RPC autenticado.
3. Construir el pipeline central Plan → Snapshot → Execute → Verify.
4. Integrar riesgo dinámico, approvals verificables, locks e idempotencia.
5. Añadir SQLite WAL, artifact store content-addressed, jobs persistentes y auditoría.
6. Aplicar frame limits, backpressure, cuotas, heartbeat y lifecycle real.

### P2 — Suite de aceptación previa a Adobe

Crear una suite contractual única que se ejecute contra cualquier `AdobeBridge` y cubra:

- schema de comandos y outputs;
- revisión obsoleta;
- repetición de `operationId`;
- atomicidad no soportada;
- snapshots fallidos;
- partial failure;
- cancelación;
- pérdida de conexión;
- R3/R4 sin approval;
- frame oversized, replay y origin spoofing;
- symlinks y TOCTOU;
- outputs ausentes o corruptos.

`test:e2e` debe fallar si no descubre ninguna prueba.

### P3 — Paneles reales

Una vez estabilizado el núcleo:

1. Photoshop UXP como primera vertical completa.
2. Illustrator UXP con fallback JSX versionado y firmado.
3. After Effects Socket Bridge y worker `aerender` separado.
4. Premiere UXP, dejando CEP como bundle y trust boundary independientes.
5. Implementar cada capability de forma explícita; una capability ausente debe producir `UNSUPPORTED_CAPABILITY`.
6. No anunciar `atomic`, `snapshot`, `export` o cancelación hasta superar la suite contractual correspondiente.

En resumen: la estructura de paquetes es aprovechable, pero el siguiente hito no debería ser “crear paneles”; debería ser **cerrar los contratos, el protocolo autenticado y el orquestador seguro**. Solo después conviene conectar los runtimes Adobe reales.