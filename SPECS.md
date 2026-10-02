# adobe-mcp — Especificación técnica maestra

> **Estado:** normativa · **Versión:** 1.0.0 · **Fecha:** 2026-10-01  
> **Repositorio:** `D:\mcp\adobe-mcp`  
> **Convención:** DEBE, NO DEBE, DEBERÍA y PUEDE se interpretan según RFC 2119.

## 1. Propósito y alcance

`adobe-mcp` permite a agentes compatibles con Model Context Protocol inspeccionar y automatizar Adobe Photoshop, Illustrator, After Effects y Premiere Pro mediante una única superficie local, estable y segura. Abstrae UXP, ExtendScript, CEP, COM y procesos CLI sin exponer objetos nativos ni ejecución arbitraria.

Esta especificación define arquitectura, protocolos, bridges, 36 herramientas de dominio, DTOs Zod/JSON Schema, workflows, seguridad, monorepo, pruebas y operación. Quedan fuera de v1 el acceso remoto por Internet, un backend cloud propio, automatización por clicks como transporte primario y cualquier herramienta que acepte JavaScript, JSX o shell arbitrario.

## 2. Principios

1. Un único servidor MCP habla STDIO con el agente.
2. Todo acceso Adobe permanece local y con mínimo privilegio.
3. Los contratos de dominio son estables; los adaptadores Adobe son reemplazables.
4. Operaciones por lotes reducen rondas y tokens, sin perder validación por comando.
5. Toda mutación sigue Plan → Snapshot → Execute → Verify.
6. Una capacidad ausente produce `UNSUPPORTED_CAPABILITY`; nunca éxito simulado.
7. Los IDs son opacos, no nombres ni índices, y están ligados a sesión/revisión.
8. Logs estructurados nunca contienen secretos ni contenido creativo por defecto.

## 3. Arquitectura

```text
AI/MCP client ── JSON-RPC/MCP STDIO ──► Gateway Server
                                             │ IPC local autenticado
                                      Local Bridge Daemon
                         ┌──────────────┬─────┴────────┬──────────────┐
                    Photoshop      Illustrator   After Effects    Premiere Pro
                    UXP / COM      UXP / JSX     JSX / aerender   UXP / CEP
```

### 3.1 MCP Gateway Server

Proceso Node.js único iniciado por el cliente MCP. DEBE reservar `stdout` para MCP, validar entrada y salida, publicar catálogo/recursos, aplicar política, approvals y workflows, y traducir errores sin filtrar stacks o secretos. El diagnóstico usa `stderr`. NO DEBE cargar SDKs Adobe, COM ni ejecutar CLI directamente.

### 3.2 Local Bridge Daemon

Proceso de usuario de larga duración que:

- escucha solo en `127.0.0.1`/`::1` y registra panels con heartbeat;
- autentica, negocia capacidades y enruta RPC;
- mantiene colas, locks, jobs, snapshots, auditoría y artefactos;
- detecta procesos Adobe y correlaciona instancias/panels;
- aloja adaptadores COM, JSX, CEP y workers CLI;
- sobrevive a reinicios del gateway mientras existan trabajos.

Se inicia bajo demanda y puede terminar tras inactividad si no hay clientes ni jobs. Nunca requiere privilegios administrativos por defecto.

### 3.3 Panels y adaptadores

Cada panel abre una conexión saliente al daemon, anuncia app/versión/instancia/capacidades, ejecuta en el contexto exigido por el host y convierte objetos nativos en DTOs planos. Debe limitar profundidad/tamaño, devolver una revisión nueva tras mutar, cerrar limpiamente y reconectar con backoff exponencial con jitter.

### 3.4 Transporte y autenticación

El contrato lógico Gateway–Daemon y Daemon–Panel es JSON-RPC 2.0. Se recomienda WebSocket para panels y named pipe/Unix socket para gateway cuando estén disponibles.

Handshake `bridge.hello`:

```json
{
  "jsonrpc":"2.0","id":"01J...","method":"bridge.hello",
  "params":{"protocolVersion":"1.0","instanceId":"uuid",
    "client":{"kind":"uxp","app":"photoshop","appVersion":"27.0.0"},
    "capabilities":["state.read@1","layers.write@1"],
    "auth":{"scheme":"challenge-hmac","clientNonce":"base64url"}}
}
```

La prueba es `HMAC-SHA-256(token, clientNonce || serverNonce || sessionId || protocolVersion)`. El token tiene 256 bits, vive en credential store/archivo privado y nunca aparece en URL o logs. Requisitos:

- bind exclusivo a loopback y allowlist de `Origin`/plugin ID;
- WSS con pinning cuando el runtime lo permita; WS loopback solo con challenge-HMAC;
- frames ≤ 8 MiB; contenido mayor mediante `ArtifactRef`;
- ping 10 s, degradado 30 s, desconectado 45 s;
- 8 lecturas en vuelo por bridge y una mutación por documento raíz;
- JSON-RPC batch deshabilitado: el batching es de dominio.

### 3.5 Ciclo de vida y detección

El daemon combina: registro autenticado (autoritativo), sondeo de procesos (solo presencia) y probes de fallback sin mutación.

```text
discovered → connecting → ready ⇄ busy
                  │          │
                  └────► degraded → disconnected → expired
```

Se respeta `target.instanceId`; si falta, se elige la instancia ready con documento activo y foco más reciente. Se prefiere el transporte primario que cubra todas las capacidades. Empates devuelven `AMBIGUOUS_TARGET`. Eventos: `bridge.connected`, `bridge.disconnected`, `host.activeChanged`, `document.changed`, `job.changed`.

### 3.6 Consistencia

- Toda raíz editable lleva `revision` opaca y monotónica en la sesión.
- Mutaciones aceptan `expectedRevision`; un valor obsoleto causa `CONFLICT`.
- `operationId` UUID hace idempotente la operación durante al menos 24 h.
- Locks son leases de 30 s y se adquieren en orden canónico.
- `atomic:true` se rechaza si el bridge no anuncia `batch.atomic@1`.
- Un fallo parcial enumera comandos aplicados, fallidos y compensables.

## 4. Contratos comunes

Zod en `packages/schemas` es la fuente normativa; CI genera JSON Schema Draft 2020-12 y tipos TypeScript. Los schemas públicos usan `.strict()`.

```ts
import { z } from "zod";
export const AppId=z.enum(["photoshop","illustrator","after-effects","premiere-pro"]);
export const OpaqueId=z.string().min(1).max(256);
export const Revision=z.string().min(1).max(128);
export const OperationId=z.string().uuid();
export const TargetRef=z.object({app:AppId,instanceId:OpaqueId.optional(),projectId:OpaqueId.optional(),documentId:OpaqueId.optional(),entityId:OpaqueId.optional()}).strict();
export const RationalTime=z.object({ticks:z.string().regex(/^-?\d+$/),timebase:z.string().regex(/^\d+$/)}).strict();
export const PageRequest=z.object({cursor:z.string().max(2048).optional(),limit:z.number().int().min(1).max(200).default(50)}).strict();
export const ReadOptions=z.object({fields:z.array(z.string()).max(64).optional(),depth:z.number().int().min(0).max(4).default(1),page:PageRequest.optional()}).strict();
export const MutationOptions=z.object({operationId:OperationId,expectedRevision:Revision.optional(),dryRun:z.boolean().default(false),atomic:z.boolean().default(true),conflictPolicy:z.enum(["fail","rebase-safe"]).default("fail"),verification:z.enum(["none","state","render-proof"]).default("state"),approvalToken:z.string().max(4096).optional()}).strict();
export const FileGrant=z.object({grantId:OpaqueId,access:z.enum(["read","write","read-write"]),suggestedName:z.string().max(255).optional()}).strict();
export const ArtifactRef=z.object({artifactId:OpaqueId,kind:z.enum(["file","directory","snapshot","preview","report"]),displayName:z.string(),mediaType:z.string().optional(),sizeBytes:z.number().int().nonnegative().optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),expiresAt:z.string().datetime().optional()}).strict();
```

Convenciones: fechas RFC 3339 UTC; media como `RationalTime`, nunca float; ángulos en grados; color con espacio explícito y componentes `[0,1]`; matrices 2D `[a,b,c,d,tx,ty]`; rutas de usuario solo por grants; nombres nunca identifican entidades.

Errores normalizados: `INVALID_ARGUMENT`, `UNAUTHENTICATED`, `PERMISSION_DENIED`, `APP_NOT_RUNNING`, `BRIDGE_UNAVAILABLE`, `UNSUPPORTED_CAPABILITY`, `AMBIGUOUS_TARGET`, `NOT_FOUND`, `CONFLICT`, `LOCKED`, `USER_CANCELLED`, `TIMEOUT`, `RATE_LIMITED`, `PARTIAL_FAILURE`, `HOST_ERROR`, `EXPORT_FAILED`, `VERIFICATION_FAILED`, `SNAPSHOT_FAILED`, `INTERNAL`. Incluyen `requestId`, `retryable`, detalles seguros, operaciones aplicadas y recuperación sugerida.

## 5. Bridges por aplicación

Todos implementan `connect`, `health`, `inspect`, `mutate`, `export`, `snapshot`, `verify`, `cancel` y `close`. El descriptor contiene transport, app/versiones, instance/PID, capabilities versionadas y límites.

### 5.1 Photoshop

**Primario:** panel UXP WebSocket. Usa DOM y encapsula `batchPlay` cuando haga falta; sus descriptores nunca cruzan MCP. Ejecuta mutaciones en contexto modal, agrupa historia cuando sea posible e inspecciona documentos, artboards, capas, máscaras, smart objects y selección.

**Fallback Windows:** worker COM STA con allowlist, sin `eval`. Menor cobertura, cancelación best-effort y sin atomicidad fuerte. UXP y COM nunca escriben dentro de la misma transacción.

```ts
const PsLayer=z.object({id:OpaqueId,name:z.string(),kind:z.enum(["pixel","text","shape","group","adjustment","smart-object","fill","unknown"]),parentId:OpaqueId.nullable(),visible:z.boolean(),locked:z.boolean(),opacity:z.number().min(0).max(1),blendMode:z.string(),bounds:z.object({x:z.number(),y:z.number(),width:z.number().nonnegative(),height:z.number().nonnegative(),unit:z.enum(["px","pt","mm","in"])}),selected:z.boolean()}).strict();
const PsDocumentState=z.object({id:OpaqueId,revision:Revision,name:z.string(),saved:z.boolean(),width:z.number().positive(),height:z.number().positive(),unit:z.enum(["px","pt","mm","in"]),resolutionPpi:z.number().positive(),mode:z.enum(["bitmap","grayscale","rgb","cmyk","lab","multichannel","duotone","indexed"]),bitDepth:z.enum([8,16,32]),activeLayerIds:z.array(OpaqueId),layers:z.array(PsLayer),truncated:z.boolean(),nextCursor:z.string().optional()}).strict();
const PsLayerCommand=z.discriminatedUnion("op",[
 z.object({op:z.literal("create"),tempId:z.string(),kind:z.enum(["pixel","text","shape","group","adjustment"]),name:z.string(),parentId:OpaqueId.optional(),properties:z.record(z.string(),z.unknown())}),
 z.object({op:z.literal("set"),layerId:OpaqueId,patch:z.object({name:z.string().optional(),visible:z.boolean().optional(),opacity:z.number().min(0).max(1).optional(),blendMode:z.string().optional(),locked:z.boolean().optional()}).strict()}),
 z.object({op:z.literal("transform"),layerIds:z.array(OpaqueId).min(1),matrix:z.tuple([z.number(),z.number(),z.number(),z.number(),z.number(),z.number()])}),
 z.object({op:z.literal("delete"),layerIds:z.array(OpaqueId).min(1),permanent:z.literal(false).default(false)})]);
const PsExport=z.object({target:TargetRef,format:z.enum(["psd","psb","png","jpeg","tiff","webp"]),destination:FileGrant,options:z.object({quality:z.number().int().min(1).max(100).optional(),embedProfile:z.boolean().default(true),flatten:z.boolean().default(false),scale:z.number().positive().max(16).default(1)}).strict(),mutation:MutationOptions}).strict();
```

### 5.2 Illustrator

**Primario:** UXP WebSocket cuando el runtime anuncie cada capability; no se presume paridad con Photoshop. **Fallback:** biblioteca ExtendScript `.jsx` versionada y comprobada por hash. Solo invoca handlers allowlisted con JSON; jamás interpola entrada en código. Restaura selección y devuelve código/línea de error.

```ts
const AiBounds=z.object({left:z.number(),top:z.number(),right:z.number(),bottom:z.number(),unit:z.enum(["pt","px","mm","in"])}).strict();
const AiItem=z.object({id:OpaqueId,name:z.string(),type:z.enum(["path","compound-path","group","text","placed","raster","symbol","mesh","unknown"]),layerId:OpaqueId,parentId:OpaqueId.nullable(),bounds:AiBounds,visible:z.boolean(),locked:z.boolean(),selected:z.boolean(),opacity:z.number().min(0).max(1)}).strict();
const AiDocumentState=z.object({id:OpaqueId,revision:Revision,name:z.string(),saved:z.boolean(),colorSpace:z.enum(["rgb","cmyk"]),activeArtboardId:OpaqueId,artboards:z.array(z.object({id:OpaqueId,name:z.string(),bounds:AiBounds})),layers:z.array(z.object({id:OpaqueId,name:z.string(),visible:z.boolean(),locked:z.boolean(),itemCount:z.number().int()})),items:z.array(AiItem),truncated:z.boolean(),nextCursor:z.string().optional()}).strict();
const AiEditCommand=z.discriminatedUnion("op",[
 z.object({op:z.literal("create-layer"),tempId:z.string(),name:z.string(),parentId:OpaqueId.optional()}),
 z.object({op:z.literal("create-item"),tempId:z.string(),itemType:z.enum(["rectangle","ellipse","path","text","group"]),layerId:OpaqueId,geometry:z.record(z.string(),z.unknown()),style:z.record(z.string(),z.unknown())}),
 z.object({op:z.literal("transform"),itemIds:z.array(OpaqueId).min(1),matrix:z.tuple([z.number(),z.number(),z.number(),z.number(),z.number(),z.number()])}),
 z.object({op:z.literal("delete"),itemIds:z.array(OpaqueId).min(1),permanent:z.literal(false).default(false)})]);
const AiExport=z.object({target:TargetRef,scope:z.object({artboardIds:z.array(OpaqueId).optional(),itemIds:z.array(OpaqueId).optional()}),format:z.enum(["ai","pdf","svg","eps","png","jpeg"]),destination:FileGrant,mutation:MutationOptions}).strict();
```

### 5.3 After Effects

**Interactivo:** ExtendScript Socket Bridge, una mutación a la vez, lotes troceados, `beginUndoGroup/endUndoGroup` garantizado, handlers preinstalados y cancelación entre unidades. Los índices nativos base 1 no son IDs públicos.

**Fondo:** worker `aerender` localizado por versión. Se lanza sin shell, desde argv tipado, preferentemente sobre copia del proyecto. Captura progreso/salida/código, limita CPU/RAM y cancela primero de forma cooperativa.

```ts
const AeValue=z.union([z.string(),z.number(),z.boolean(),z.array(z.number()).max(16)]);
const AeLayer=z.object({id:OpaqueId,index:z.number().int().positive(),name:z.string(),type:z.enum(["av","text","shape","camera","light","null","adjustment","unknown"]),sourceId:OpaqueId.optional(),parentId:OpaqueId.nullable(),enabled:z.boolean(),locked:z.boolean(),threeD:z.boolean(),inPoint:RationalTime,outPoint:RationalTime,startTime:RationalTime,selected:z.boolean()}).strict();
const AeCompState=z.object({id:OpaqueId,revision:Revision,name:z.string(),width:z.number().int().positive(),height:z.number().int().positive(),pixelAspect:z.number().positive(),frameRate:z.number().positive(),duration:RationalTime,workArea:z.object({start:RationalTime,duration:RationalTime}),layers:z.array(AeLayer),truncated:z.boolean(),nextCursor:z.string().optional()}).strict();
const AeEditCommand=z.discriminatedUnion("op",[
 z.object({op:z.literal("create-layer"),tempId:z.string(),kind:z.enum(["solid","text","shape","null","camera","light"]),name:z.string(),options:z.record(z.string(),z.unknown())}),
 z.object({op:z.literal("set-property"),layerId:OpaqueId,propertyPath:z.array(z.string()).min(1).max(16),value:AeValue}),
 z.object({op:z.literal("set-keyframes"),layerId:OpaqueId,propertyPath:z.array(z.string()).min(1).max(16),mode:z.enum(["merge","replace-range"]),keyframes:z.array(z.object({time:RationalTime,value:AeValue,interpolation:z.enum(["linear","bezier","hold"])})).min(1).max(5000)}),
 z.object({op:z.literal("delete-layer"),layerIds:z.array(OpaqueId).min(1),permanent:z.literal(false).default(false)})]);
const AeRender=z.object({target:TargetRef,mode:z.enum(["queue","aerender"]),compId:OpaqueId,range:z.object({start:RationalTime,end:RationalTime}).optional(),renderSettingsTemplate:z.string().max(256).optional(),outputModuleTemplate:z.string().max(256).optional(),destination:FileGrant,overwrite:z.boolean().default(false),mutation:MutationOptions}).strict();
```

### 5.4 Premiere Pro

**Primario:** UXP Timeline/Bin Bridge. Encapsula DOM asíncrono, acciones y acceso bloqueado; no retiene objetos nativos más allá de su vigencia. **Fallback:** CEP/ExtendScript para APIs heredadas; `evalScript` recibe handler allowlisted + JSON codificado, nunca código externo. QE no documentado queda fuera del baseline y exige feature flag experimental.

```ts
const PrClip=z.object({id:OpaqueId,name:z.string(),projectItemId:OpaqueId.optional(),trackId:OpaqueId,mediaType:z.enum(["video","audio","caption","unknown"]),start:RationalTime,end:RationalTime,sourceIn:RationalTime,sourceOut:RationalTime,speed:z.number(),enabled:z.boolean()}).strict();
const PrTrack=z.object({id:OpaqueId,index:z.number().int().nonnegative(),name:z.string(),type:z.enum(["video","audio","caption"]),locked:z.boolean(),muted:z.boolean().optional(),targeted:z.boolean().optional(),clips:z.array(PrClip)}).strict();
const PrSequenceState=z.object({id:OpaqueId,revision:Revision,name:z.string(),frameSize:z.object({width:z.number().int().positive(),height:z.number().int().positive()}),frameRate:z.number().positive(),duration:RationalTime,tracks:z.array(PrTrack),markers:z.array(z.object({id:OpaqueId,name:z.string(),start:RationalTime,duration:RationalTime,comment:z.string().optional()})),truncated:z.boolean(),nextCursor:z.string().optional()}).strict();
const PrTimelineCommand=z.discriminatedUnion("op",[
 z.object({op:z.literal("insert"),projectItemId:OpaqueId,trackId:OpaqueId,at:RationalTime,sourceIn:RationalTime.optional(),sourceOut:RationalTime.optional(),mode:z.enum(["insert","overwrite"])}),
 z.object({op:z.literal("move"),clipIds:z.array(OpaqueId).min(1),delta:RationalTime,targetTrackId:OpaqueId.optional()}),
 z.object({op:z.literal("trim"),clipId:OpaqueId,edge:z.enum(["in","out"]),to:RationalTime,ripple:z.boolean()}),
 z.object({op:z.literal("cut"),trackIds:z.array(OpaqueId).min(1),at:RationalTime}),
 z.object({op:z.literal("delete"),clipIds:z.array(OpaqueId).min(1),ripple:z.boolean(),permanent:z.literal(false).default(false)})]);
const PrExport=z.object({target:TargetRef,sequenceId:OpaqueId,engine:z.enum(["premiere","media-encoder"]),range:z.enum(["entire","in-out","work-area"]),presetId:OpaqueId,destination:FileGrant,overwrite:z.boolean().default(false),mutation:MutationOptions}).strict();
```

## 6. Catálogo MCP: 36 herramientas

Las herramientas son gruesas, paginadas y seleccionables por `fields`; no replican cada método DOM.

| Grupo | Herramientas |
|---|---|
| Comunes (10) | `adobe.system.status`, `adobe.system.capabilities`, `adobe.system.activate`, `adobe.state.inspect`, `adobe.assets.grant`, `adobe.operations.plan`, `adobe.operations.execute`, `adobe.operations.undo`, `adobe.jobs.get`, `adobe.jobs.cancel` |
| Photoshop (6) | `adobe.photoshop.inspect`, `adobe.photoshop.document`, `adobe.photoshop.layers.edit`, `adobe.photoshop.layers.content`, `adobe.photoshop.filters.apply`, `adobe.photoshop.export` |
| Illustrator (6) | `adobe.illustrator.inspect`, `adobe.illustrator.document`, `adobe.illustrator.objects.edit`, `adobe.illustrator.text.edit`, `adobe.illustrator.assets.place`, `adobe.illustrator.export` |
| After Effects (7) | `adobe.aftereffects.inspect`, `adobe.aftereffects.project`, `adobe.aftereffects.compositions.edit`, `adobe.aftereffects.layers.edit`, `adobe.aftereffects.keyframes.edit`, `adobe.aftereffects.renderqueue.edit`, `adobe.aftereffects.render` |
| Premiere (7) | `adobe.premiere.inspect`, `adobe.premiere.project.edit`, `adobe.premiere.sequences.edit`, `adobe.premiere.timeline.edit`, `adobe.premiere.effects.edit`, `adobe.premiere.markers.edit`, `adobe.premiere.export` |

Todas las `*.edit` aceptan `{target, commands[1..500], options:MutationOptions, return?}`. Su recibo contiene status (`planned|applied|partial|rolled-back|queued`), revisión anterior/posterior, índices aplicados/fallidos, mapa de `tempId`, snapshot, verificación y job. Mapas flexibles se validan otra vez contra una allowlist por host/versión.

Las inspecciones cubren: documentos, selección, árboles/capas; artboards/page items; proyectos/comps/render queue; bins/secuencias/tracks/clips/marcadores. Exportaciones cubren presets, formatos, rangos, render queue, `aerender` y Media Encoder, siempre según capacidades anunciadas.

## 7. Workflows y ejecución segura

Un workflow es un DAG versionado de llamadas públicas; admite dependencias, JSON Pointer restringido, condiciones de igualdad, máximo 3 reintentos y compensaciones. No admite scripts. Al planificar se rechazan ciclos, referencias inválidas, schemas incompatibles y fan-out excesivo.

### 7.1 Pipeline obligatorio

1. **Plan:** resolver targets/capabilities, validar schemas/grants, obtener revisiones, clasificar riesgo, estimar tiempo/espacio y producir diff, `planId`, hash y expiración.
2. **Checkpoint/Snapshot:** metadato/undo para bajo riesgo; copia versionada para R2+; hash SHA-256 y verificación de espacio/legibilidad antes de seguir.
3. **Execute:** revalidar plan/aprobación/revisiones, adquirir locks, ejecutar chunks idempotentes y detener al fallar una precondición. Nunca ampliar alcance.
4. **Verify:** reinspeccionar postcondiciones; para outputs, comprobar existencia, tamaño, hash y decodificación básica. `render-proof` añade preview. Si falla, no reportar éxito y compensar según política.

| Riesgo | Ejemplos | Requisito |
|---|---|---|
| R0 | lectura, status, plan | sin confirmación |
| R1 | crear, exportar a destino nuevo | política o intención de llamada |
| R2 | modificar contenido, mover/cortar, keyframes | snapshot + diff |
| R3 | borrar, sobrescribir, rasterizar, relink masivo | snapshot verificado + approval ligado al plan |
| R4 | original/proyecto sobrescrito o pérdida irreversible | confirmación explícita reciente; unattended denegado por defecto |

Más de 50 entidades, 10 archivos, 5 GiB o 10 minutos elevan un nivel. `permanent:true` no existe en baseline; save-copy y `overwrite:false` son defaults. Approval tokens contienen hash/alcance/riesgo/nonce/TTL ≤ 10 min. Cambios externos invalidan el plan.

### 7.2 Flujo cruzado de referencia

Photoshop exporta capas nuevas → Illustrator coloca/compone y exporta AI/SVG → After Effects importa, anima y renderiza con `aerender` → Premiere importa, inserta y exporta por preset. Cada paso intercambia `ArtifactRef` con hash y procedencia, nunca rutas libres. No se promete ACID multiapp: se usa saga con snapshot por host y compensaciones (retirar import, borrar entidad recién creada, restaurar copia).

## 8. Seguridad

Amenazas: proceso local hostil, web→loopback, prompt destructivo, payload malformado, traversal/symlink, inyección JSX/shell, replay, panel comprometido, archivo manipulado y DoS.

Controles obligatorios:

- HMAC, nonces de un uso, TTL, rotación y ACL de usuario;
- allowlist de origins, IDs, versiones, handlers y capabilities;
- schemas estrictos y límites de strings, arrays, profundidad y mensajes;
- CLI con argv sin shell; JSX/CEP por handler inmutable verificado por hash;
- grants y canonicalización posterior a symlinks;
- rate limits, cuotas y backpressure;
- lockfile, SBOM, dependencias fijadas y escaneo CI;
- auditoría append-only; redacción de tokens, rutas y contenido.

`adobe-mcp.policy.json` define apps, roots, formatos, límites, riesgo, interacción y retención. Por defecto: sin red externa, loopback único, ejecución arbitraria prohibida, R3/R4 interactivos, telemetría opt-in, snapshots 7 días y logs 30 días.

## 9. Monorepo y contratos

```text
apps/
  gateway/  daemon/  photoshop-uxp/  illustrator-uxp/
  aftereffects-panel/  premiere-uxp/  premiere-cep/
packages/
  schemas/ protocol/ bridge-core/
  bridge-photoshop/ bridge-illustrator/ bridge-aftereffects/ bridge-premiere/
  tool-catalog/ workflow-engine/ policy/ jobs/ observability/ testkit/ config/
scripts/ fixtures/ docs/ pnpm-workspace.yaml turbo.json tsconfig.base.json
```

Reglas: `schemas ← protocol ← bridge-core ← adaptadores`; gateway no importa SDKs Adobe; panels comparten tipos serializables, no Node; sin ciclos; `workspace:*`; TypeScript strict; ESM salvo bundle exigido por Adobe. Cada runtime tiene bundle separado y no se presume que UXP sea navegador o Node completo.

Scripts raíz: `build`, `dev`, `lint`, `typecheck`, `test`, `test:contract`, `test:e2e`, `schemas:generate`, `schemas:check`, `package`, `clean`. CI usa `pnpm --frozen-lockfile` y falla si JSON Schema generado cambia.

## 10. Jobs, eventos y almacenamiento

Jobs: `queued → running → succeeded|failed|cancelled` y `running → cancelling → cancelled|failed`; terminales inmutables. Contienen kind, progress, timestamps, operationId, artifacts y error. Cancelar es cooperativo y declara si el host ya no puede detenerse.

Eventos incluyen `eventId`, timestamp, sequence, session/request/operation IDs y payload validado. Entrega al menos una vez; consumidores deduplican por `eventId`.

SQLite WAL almacena metadata; filesystem privado y content-addressed almacena artefactos. Migraciones son monotónicas/transaccionales. El archivo rendezvous de daemon se escribe atómicamente con ACL de usuario, endpoint, PID y start-time.

## 11. Compatibilidad, rendimiento y observabilidad

SemVer para distribución. Major de protocolo/capability es incompatible; minor solo añade campos opcionales. La selección usa capability probing, no solo versión. UXP es preferente y COM/JSX/CEP son fallbacks explícitos registrados en `docs/compatibility.md`.

Objetivos, excluido tiempo propio del host: status p95 <100 ms, inspección simple <500 ms, overhead de mutación <150 ms, gateway cold <3 s. Límites: 100 requests globales pendientes, 8 por bridge, una escritura por raíz; exceso produce `RATE_LIMITED` con `retryAfterMs`.

Logs correlacionan `requestId`, `operationId` y `traceId`. Métricas: latencia, conexiones, jobs, conflictos, rollbacks, verificación, bytes/almacenamiento. No se registra contenido de documentos por defecto.

## 12. Pruebas y aceptación

- Unitarias: schemas, policy, DAG, riesgos, paths y redacción.
- Contract: todos los adaptadores contra la suite `AdobeBridge`.
- Fuzz: frames, campos extra, tamaños, replay y orden de eventos.
- Integración: reconexión, locks, timeouts, idempotencia y fallos parciales.
- E2E: fixtures reales por host/versión, undo/snapshot y outputs decodificables.
- Seguridad: origin spoofing, traversal, symlink, inyección JSX/argv, replay y DoS.
- Resiliencia: terminar panel/daemon/host en cada fase y reconciliar.

Criterios críticos: revisión obsoleta nunca muta; repetir operationId no duplica; R3/R4 sin token no toca host; fallo de snapshot bloquea; output corrupto no sucede; desconexión conserva jobs; ninguna entrada llega a shell/eval; cada herramienta tiene schema, handler, contrato y documentación.

## 13. Distribución y definición de terminado

Release: gateway/daemon por plataforma con checksums/SBOM, paquetes UXP, CEP separado, JSX con manifest de hashes y matriz de compatibilidad. La desinstalación revoca token y ofrece conservar/borrar datos técnicos, nunca proyectos o exports.

V1 termina cuando:

- pnpm/Turbo compila reproduciblemente;
- gateway/daemon autentican, reconectan y apagan limpiamente;
- cuatro hosts pasan lectura y al menos una mutación/export segura;
- las 36 herramientas cumplen schemas y política;
- flujo cruzado con hashes/compensación funciona;
- snapshots, approvals, locks, idempotencia y verificación superan fallos inducidos;
- no hay hallazgos críticos/altos abiertos;
- compatibilidad, instalación y recuperación están documentadas.

## 14. Decisiones pendientes (ADR)

1. IPC exacto Gateway–Daemon por plataforma.
2. Certificado/pinning aceptado por cada runtime UXP.
3. versiones mínimas y retirada programada de COM/CEP/JSX;
4. credential store por SO;
5. garantías reales de undo/snapshot por host;
6. firma/distribución empresarial;
7. integración Media Encoder por versión.

---

Esta es la especificación maestra. Una implementación que la contradiga requiere cambio versionado de `SPECS.md`, ADR y, si afecta compatibilidad, nueva versión de schema/protocolo.
