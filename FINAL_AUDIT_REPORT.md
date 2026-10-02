# Reauditoría P0/P1 de adobe-mcp

**Fecha:** 2026-10-01  
**Especificación de referencia:** `SPECS.md` v1.0.0  
**Alcance:** remediaciones P0/P1 en `apps/gateway`, `apps/daemon`, protocolo, policy, bridges, snapshots e idempotencia.  
**Método:** revisión estática del código fuente, trazabilidad requisito-implementación, typecheck y tests limpios, comprobación del manifiesto de schemas y prueba de integración autenticada Gateway → Daemon sobre WebSocket loopback.

## 1. Veredicto de recertificación

**NO CERTIFICADO. Las remediaciones son materiales, pero los gaps P0/P1 no están cerrados en su totalidad.**

El estado ha mejorado de forma significativa respecto de la auditoría anterior:

- ya existe un cliente Gateway → Daemon real, sin el stub anterior;
- el enlace usa WebSocket loopback y challenge-HMAC con un secreto local persistente;
- el Gateway valida de forma estricta los envelopes de salida y rechaza respuestas antiguas o no envelopadas;
- existen primitivas correctas para ligar approvals a `planHash`, `scopeHash`, riesgo y nonce;
- el handshake de After Effects incluye HMAC, comparación en tiempo constante y protección de replay por nonce;
- `aerender` se resuelve desde rutas oficiales allowlisted y se ejecuta con argv y `shell:false`.

Sin embargo, no se puede certificar una resolución exitosa completa porque siguen abiertos tres bloqueantes:

1. El pipeline de mutación no garantiza rollback real para los bridges productivos y no usa idempotencia durable.
2. Los snapshots de los panels son hashes de representaciones JSON en memoria, no artefactos content-addressed persistidos y restaurables.
3. `OperationStore` existe como `Map` serializable, pero no está conectado al daemon ni a `MutationOrchestrator`, y no persiste automáticamente entre reinicios.

Además, el rendezvous no está implementado como registro seguro de endpoint/PID/start-time: Gateway y Daemon se encuentran mediante un puerto fijo o variable de entorno y un archivo de token compartido.

### 1.1 Resultado por requisito solicitado

| # | Requisito | Estado | Conclusión |
|---:|---|---|---|
| 1 | Gateway → Daemon por WebSocket loopback autenticado, token persistente/rendezvous, sin stubs | **Parcial** | Conexión y autenticación reales demostradas; token persistente correcto. Falta rendezvous seguro de endpoint/proceso. |
| 2 | Envelope estricto `{ ok: true, data }` o `{ ok: false, error }` validado en Gateway sin bypasses | **Resuelto** | Los schemas son estrictos y el Gateway siempre ejecuta `validateToolOutput`; el bypass anterior desapareció. |
| 3 | Plan → Snapshot → Locks → ejecución idempotente `(operationId,inputHash)` → verificación → rollback | **No resuelto** | El orden básico existe para mutaciones de dominio, pero plan e idempotencia son memoria volátil, exports siguen otra ruta y el rollback no está disponible en `PanelBridge`. |
| 4 | Approval R3/R4 ligado a `planHash`, `scopeHash`, riesgo y nonce | **Parcial** | La firma liga los cuatro valores y el nonce se consume, pero plan/nonces no son persistentes ni se contrastan completamente con la operación almacenada; R4 usa un booleano de la misma petición, no una confirmación reciente persistida. |
| 5 | Handshake HMAC de After Effects, comparación constante y nonces únicos | **Resuelto en código** | HMAC y comparación constante están implementados en Node y JSX; el daemon mantiene nonces usados. Falta una prueba con After Effects real. |
| 6 | `aerender` solo desde instalaciones oficiales, argv sin shell | **Resuelto** | Se rechaza `aerenderPath`, se allowlistean rutas Adobe, se vuelve a validar el ejecutable resuelto y se usa `spawn(executable,args,{shell:false})`. |
| 7 | Snapshots content-addressed reales, hashes comprobables y `OperationStore` | **No resuelto** | Hay hashes sintácticamente válidos, pero no un artifact store real/restaurable; `OperationStore` no es durable ni está integrado. |

**Resultado agregado: 3 resueltos, 2 parciales y 2 no resueltos.** Los puntos 3 y 7 son P0/P1 bloqueantes, por lo que la certificación continúa denegada.

## 2. Evidencia de ejecución

Se ejecutaron desde la raíz del monorepo:

| Comando/comprobación | Resultado | Observación |
|---|---|---|
| `pnpm turbo run typecheck --force` | **Pasa** | 29 tareas correctas. |
| `pnpm turbo run test --force` | **Pasa** | 31 tareas; 39 tests Vitest pasan, además de validaciones/compilaciones de apps. |
| `pnpm schemas:check` | **Pasa** | El manifiesto generado coincide con el versionado. |
| `pnpm test:e2e` | **Pasa sin casos E2E** | Solo ejecuta 10 builds cacheados; ningún paquete declara un script `test:e2e`. No constituye evidencia E2E. |
| Integración manual `LocalBridgeDaemon` + `WebSocketDaemonClient` | **Pasa** | El Gateway autenticado recibió `{"ok":true,"data":{"status":"degraded",...}}` a través de `ws://127.0.0.1:<puerto>`. |

No se ejecutaron Photoshop, Illustrator, After Effects o Premiere reales. Por tanto, las garantías de host siguen basadas en revisión estática y mocks.

## 3. Hallazgos detallados

### 3.1 Gateway → Daemon: conexión real, pero rendezvous incompleto

La remediación elimina el stub crítico anterior. `WebSocketDaemonClient` abre un WebSocket real, responde al challenge con `computeAuthProof` y solo considera la sesión autenticada tras el welcome (`apps/gateway/src/index.ts`). El entrypoint del Gateway usa este cliente y lee el token desde `localTokenPath()`.

El daemon:

- enlaza explícitamente en `127.0.0.1`;
- limita el tamaño de frames;
- valida dirección remota y Origin;
- emite `auth.challenge` con nonce, sessionId y expiración;
- verifica HMAC y rechaza nonces ya usados;
- distingue clientes `gateway` de panels antes de aceptar RPC de herramientas.

El token se crea con 32 bytes aleatorios y se guarda con creación exclusiva y modo `0600` (`packages/protocol/src/index.ts`). Esto sí proporciona un secreto persistente compartido.

La parte no resuelta es el rendezvous: no existe un descriptor atómico que publique puerto real, PID, start-time y versión con ACL. El puerto por defecto es `49152` y solo se cambia mediante `ADOBE_MCP_DAEMON_PORT`. Tampoco hay autostart ni validación de que el proceso encontrado corresponda al daemon esperado. Por ello el requisito 1 solo puede considerarse parcial.

### 3.2 Envelope estricto: resuelto

El catálogo define exclusivamente estas dos formas, ambas `.strict()`:

```json
{ "ok": true, "data": {} }
{ "ok": false, "error": {} }
```

`GatewayServer.callTool()` ejecuta `validateToolOutput(name, result)` sin excepción ni rama de compatibilidad. La prueba de Gateway confirma que `{method:"adobe.system.status"}` —el bypass aceptado en la versión anterior— se rechaza como `INVALID_ARGUMENT` (`apps/gateway/src/index.test.ts`).

El daemon también valida el resultado del handler con el schema específico de la herramienta y normaliza fallos como `{ok:false,error}` antes de enviarlos. No se encontró un bypass de output en la ruta Gateway → Daemon.

### 3.3 Pipeline mandatorio: estructura presente, garantía incompleta

`MutationOrchestrator.execute()` implementa esta secuencia:

1. calcula `inputHash(request)` y consulta idempotencia;
2. registra metadatos de plan en un `Map`;
3. crea y comprueba el snapshot;
4. adquiere locks ordenados;
5. llama a `bridge.mutate()`;
6. verifica la revisión;
7. almacena el resultado idempotente;
8. intenta `restoreSnapshot()` en fallo.

Esto es una mejora real, y las mutaciones de dominio del dispatcher pasan por ese orquestador. No obstante, no satisface la garantía completa:

- `plans` e `IdempotencyStore` son `Map` en memoria; se pierden al reiniciar.
- `PanelBridge`, que es el adapter productivo de un panel conectado, no implementa `restoreSnapshot()`. El cast opcional del orquestador hace que el rollback simplemente se omita.
- Los panels Photoshop, Illustrator y After Effects tampoco exponen un RPC de restauración en sus dispatchers.
- El error de rollback se descarta silenciosamente y no queda reflejado en un receipt `rolled-back`/`partial` ni en auditoría.
- `executeExport()` duplica una versión reducida del pipeline: no consulta `(operationId,inputHash)` y solo restaura tras un fallo de verificación; si `bridge.export()` lanza después de tocar el host, no ejecuta compensación.
- `adobe.jobs.cancel` muta estado fuera del orquestador; `adobe.operations.execute` y `undo` siguen devolviendo errores de no implementación.
- El “plan” interno del orquestador no es el `Plan` hasheado del contrato y no se recupera de un store durable.

En consecuencia, el pipeline existe como esqueleto funcional, pero no es todavía una frontera ineludible, durable y compensable.

### 3.4 Approval R3/R4: criptografía correcta, binding operacional incompleto

`issueApproval()` firma mediante HMAC el payload formado por:

- `tokenId`;
- `planHash`;
- `scopeHash`;
- `risk`;
- `nonce`;
- `issuedAt` y `expiresAt`.

`verifyApproval()` compara exactamente `planHash`, `scopeHash` y riesgo esperados, comprueba tiempo y firma con `timingSafeEqual`. `consumeApprovalNonce()` impide replay dentro de la vida del proceso.

Persisten estas brechas:

- no hay plan store; el plan llega en la propia llamada;
- el Gateway no recomputa ni valida el `planHash`; esa comprobación solo ocurre en el daemon;
- el daemon no contrasta `plan.toolName`, target, digest de comandos, expiración y revisiones esperadas con la llamada que va a ejecutar;
- el riesgo usado para verificar el token se recalcula desde la llamada, pero no se exige igualdad explícita con `plan.risk`;
- los sets de nonces del Gateway y del daemon son volátiles y se vacían al reiniciar;
- R4 acepta `explicitConfirmation: true` dentro de la misma solicitud, sin prueba separada de presencia de usuario ni timestamp de confirmación.

Por ello la primitiva criptográfica está remediada, pero el flujo R3/R4 completo aún no es certificable.

### 3.5 After Effects HMAC: resuelto en código

El daemon usa HMAC-SHA-256 sobre protocolo, client nonce, server nonce y sessionId, y compara con `crypto.timingSafeEqual` (`packages/protocol/src/index.ts`). Mantiene `usedClientNonces` y rechaza replay.

El JSX implementa la misma construcción, una comparación que recorre la longitud máxima sin salida temprana y un registro de nonces usados (`apps/aftereffects-panel/src/AfterEffectsBridge.jsx`). El antiguo comportamiento de aceptar cualquier proof no vacío ya no está presente.

La cobertura sigue siendo estática: el paquete `aftereffects-panel` tiene un script de test que termina con código cero sin ejecutar casos. Esto impide elevar el resultado a “verificado en host”, pero el gap de implementación concreto sí está corregido.

### 3.6 `aerender`: resuelto

`packages/bridge-aftereffects/src/aerender.ts`:

- enumera únicamente instalaciones bajo `Program Files/Adobe/Adobe After Effects…/Support Files/aerender.exe` o `/Applications/Adobe After Effects…/aerender`;
- valida de nuevo el ejecutable devuelto por el locator;
- rechaza expresamente cualquier propiedad `aerenderPath` suministrada por la petición;
- construye argumentos como array;
- invoca `spawn(executable, args, { shell: false, windowsHide: true, ... })`.

Las pruebas del bridge cubren el rechazo de un locator no oficial y la construcción de argv. No se encontró una ruta productiva que permita inyectar un ejecutable arbitrario.

### 3.7 Snapshots y OperationStore: no resuelto

Los tipos exigen SHA-256 con formato correcto y los bridges comprueban que `snapshot.artifact.sha256 === snapshot.sha256`. Eso evita inconsistencias triviales, pero no demuestra content-addressing real.

En los panels revisados:

- Photoshop serializa el resultado de inspect, calcula un hash y devuelve `verified:true`, pero no persiste los bytes ni implementa restore.
- Illustrator hace lo mismo con JSON de inspect.
- After Effects hashea `inspectProject({depth:0})`, sin crear una copia `.aep`, checkpoint de undo restaurable o blob almacenado.
- `PanelBridge` acepta esos DTOs y no dispone de método de restauración.

Un ID aleatorio más un campo SHA-256 no es un artifact store content-addressed: falta almacenar bytes bajo el digest, releerlos, comprobar tamaño/hash y demostrar restauración.

`packages/jobs/src/index.ts` contiene `OperationStore<T>` con records `(operationId,inputHash,result,createdAt,expiresAt)`, rechazo de reutilización conflictiva y serialización JSON. Sin embargo:

- internamente sigue siendo un `Map`;
- ningún componente lo carga o guarda automáticamente;
- el daemon no lo importa;
- `MutationOrchestrator` usa otro `IdempotencyStore` en memoria;
- no existe SQLite WAL, transacción, fsync ni prueba de supervivencia a reinicio.

El requisito 7 permanece abierto.

## 4. Estado de certificación actualizado

### Mejoras aceptadas

- Se elimina el hallazgo crítico “Gateway ejecutable con daemon stub”.
- Se elimina el bypass de validación de outputs.
- Se elimina la aceptación de proof AE meramente no vacío.
- Se elimina `aerenderPath` controlable y se conserva separación argv/shell.
- Se acepta la primitiva criptográfica de approval como correctamente ligada a hash, scope, riesgo, nonce y tiempo.

### Bloqueantes abiertos

1. Implementar rendezvous seguro y atómico con endpoint, PID, start-time, versión y permisos por usuario.
2. Sustituir `IdempotencyStore`/sets/maps de producción por un store durable, y conectar `OperationStore` al daemon y al orquestador.
3. Implementar artifact store content-addressed real con escritura atómica, relectura/hash, cuotas, provenance y retención.
4. Crear snapshots restaurables por host y añadir `bridge.restoreSnapshot` al contrato productivo.
5. Hacer rollback obligatorio ante cualquier fallo posterior al snapshot, incluyendo excepción de export, y registrar el resultado de compensación.
6. Guardar planes y comparar plan, tool, target, commands digest, riesgo, scope, revisiones y expiración justo antes de ejecutar.
7. Persistir y consumir nonces de approval transaccionalmente; modelar R4 como confirmación reciente separada de la llamada mutante.
8. Añadir pruebas E2E reales. El comando `test:e2e` debe fallar si no descubre casos.

## 5. Condiciones para certificar

La certificación puede reconsiderarse cuando se demuestre conjuntamente:

- reinicio de daemon sin perder idempotencia, planes, nonces ni jobs;
- reuso de `operationId` con otro `inputHash` rechazado antes de tocar el host, incluso después de reinicio;
- snapshot almacenado por hash, corrupción detectada y restauración efectiva en cada host;
- fallo inyectado después de una mutación seguido de rollback comprobado por una inspección independiente;
- exports sometidos al mismo pipeline e idempotencia que las mutaciones;
- approval R3/R4 validado contra un plan recuperado del store, no contra un plan aportado por el cliente;
- rendezvous resistente a PID/endpoint obsoletos;
- tests E2E Gateway → Daemon → bridge real con envelopes válidos y fallos normalizados.

## 6. Conclusión

La implementación remediada ya no es el prototipo desconectado descrito por el informe anterior. La conexión Gateway → Daemon, los envelopes estrictos, HMAC de After Effects y el hardening de `aerender` son avances verificables.

No obstante, la propiedad de seguridad más importante —que toda mutación sea durablemente idempotente, precedida por un snapshot restaurable y compensada en fallo— todavía no existe en la ruta productiva. Los hashes actuales describen estado inspeccionado, no snapshots recuperables, y el `OperationStore` no participa en la ejecución.

**Decisión final: certificación denegada por P0/P1 aún abiertos.** No es correcto reflejar una “resolución exitosa” global hasta cerrar los bloqueantes de pipeline, rollback, content-addressing y persistencia descritos arriba.
