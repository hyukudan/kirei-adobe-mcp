# Dictamen de certificación — Fases F0 y F1

**Proyecto:** `adobe-mcp`  
**Fecha de auditoría:** 2026-10-02  
**Documento rector:** `OPUS_FEATURE_PROPOSAL.md`  
**Alcance:** Gateway MCP, `adobe.preview.capture`, visibilidad de sesiones y estabilidad/inmutabilidad de identificadores.

## Dictamen ejecutivo

**Resultado: NO CERTIFICADO.**

La implementación presenta una base tipada razonable y varios controles de seguridad valiosos, pero no es posible confirmar todavía la calidad, solidez y seguridad de F0/F1 en su conjunto. Hay bloqueos funcionales en After Effects y Premiere, incumplimientos del formato de respuesta solicitado, límites visuales que no se aplican a los bytes realmente exportados, identificadores cuya persistencia no está garantizada y una cobertura de pruebas insuficiente para fidelidad visual, rendimiento p95 e identidad estable.

Los checks automatizados ejecutados durante esta auditoría fueron satisfactorios:

- `pnpm turbo run test typecheck --force`: **50/50 tareas Turbo correctas, sin caché**.
- `pnpm schemas:check`: **correcto**.

Este resultado solo acredita compilación, tipado, tests unitarios existentes y sincronización de esquemas. No acredita integración con aplicaciones Adobe reales. En particular, los paquetes de panel de After Effects, Photoshop e Illustrator ejecutan respectivamente un no-op, una validación estática del bundle y un `node --check`; Premiere UXP solo ejecuta TypeScript. No hay pruebas host/E2E de captura en ninguno de los cuatro productos.

## Matriz de conformidad

| Área | Estado | Conclusión |
|---|---:|---|
| Envelope `{ ok, data, error }` | Parcial | Los outputs de catálogo son uniones estrictas `{ok:true,data}` / `{ok:false,error}` y daemon/gateway los validan. |
| Bloques MCP imagen + texto | No conforme | El Gateway emite `text` antes de `image`, contrario al orden requerido, y duplica todo el Base64 dentro del texto. |
| Registro de `adobe.preview.capture` | Conforme | Está en schemas, manifest generado, catálogo, interfaz core y dispatcher del daemon. |
| Photoshop UXP preview | Parcial | Existe captura real con `imaging.getPixels`, pero no hay prueba host ni validación semántica/tamaño del Base64. |
| Illustrator UXP preview | Parcial | Exporta y lee Base64, pero no redimensiona el archivo real, deja el temporal y reporta dimensiones que pueden no corresponder al PNG/JPEG. |
| After Effects preview | No conforme | Existe `saveFrameToPng`, pero la ruta RPC es incompatible con el daemon; además se pasa `file.fsName` en vez del objeto `File` requerido por el diseño. |
| Premiere UXP preview | No conforme | Hay una clase auxiliar con `exportFramePNG`, pero no existe host concreto, bootstrap ni instancia que la conecte al panel. La capability tampoco se anuncia. |
| `adobe.verify.visual` | Ausente | F1 lo exige expresamente y solo aparece en la propuesta. |
| Sesiones en `adobe.system.status` | Parcial | Enumera bridges reales y su salud/capabilities, pero publica un `sessionId` distinto al autenticado e ignora filtros de entrada. |
| IDs estables/inmutables | No conforme | Solo hay garantías parciales por host; faltan UUID persistentes y pruebas de reapertura/reordenación/reconexión. |
| Fidelidad visual y p95 | No demostrado | No existen benchmarks p95 ni pruebas de decodificación, dimensiones, MIME, frame solicitado o fidelidad por host. |

## Hallazgos bloqueantes

### B1 — After Effects no puede atender las llamadas RPC del daemon

**Severidad: crítica.**

El daemon envía solicitudes al panel como `{ type: "rpc", request: {...} }` (`apps/daemon/src/index.ts:31`). El receptor de After Effects parsea el objeto, pero consulta directamente `request.method` y no desempaqueta `request.request` (`apps/aftereffects-panel/src/AfterEffectsBridge.jsx:161-168`). Por ello, una petición `bridge.preview.capture` enviada por el daemon se ignora.

Además, las respuestas del panel AE se envían como JSON-RPC desnudo (`AfterEffectsBridge.jsx:14`), mientras el daemon, después de autenticar, exige que todo mensaje satisfaga el discriminante `Frame` y contenga `type` (`apps/daemon/src/index.ts:108-110`; `packages/protocol/src/index.ts:24-30`). Una respuesta desnuda falla el parseo y provoca el cierre del socket con código 1008.

La función visual existe (`AfterEffectsBridge.jsx:109-114`) pero es inalcanzable por el camino de producción auditado. La llamada también usa `comp.saveFrameToPng(time, file.fsName)` cuando la propuesta especifica `saveFrameToPng(time, file)`; debe validarse y corregirse contra el DOM real.

**Condición de cierre:** unificar framing con el daemon, pasar el tipo correcto a `saveFrameToPng` y añadir una prueba de integración que autentique, capture, decodifique el PNG y mantenga viva la sesión.

### B2 — Premiere UXP no contiene una implementación de host ejecutable

**Severidad: crítica.**

`PremiereTimelinePreviewHandler` invoca `sequence.exportFramePNG(...)` (`apps/premiere-uxp/src/index.ts:55-65`), pero no se instancia en ningún punto del repositorio. `UxpPremiereHost` es una interfaz, `capturePreview` es opcional (`index.ts:36-49`) y `createUxpPremierePanel` exige que un consumidor externo inyecte el host (`index.ts:117-139,196`). No hay bootstrap, adaptación del DOM de Premiere, obtención de secuencia activa ni fábrica de archivo concreta.

El manifest apunta a `dist/index.js`, que es una biblioteca exportada, sin inicialización de panel o conexión. La capability publicada tampoco incluye `preview.capture@1` (`index.ts:8-13`). Por tanto, no puede afirmarse que `adobe.preview.capture` esté implementada en Premiere; solo existe una primitiva reutilizable.

**Condición de cierre:** construir y registrar el host concreto, anunciar la capability, inicializar el panel desde el entrypoint y probar `exportFramePNG` en Premiere real.

### B3 — `maxDimension` no limita la imagen real en Illustrator, After Effects ni Premiere

**Severidad: alta.**

- Illustrator exporta al 100% y únicamente calcula metadatos reducidos (`apps/illustrator-uxp/index.js:79`).
- After Effects guarda el frame a resolución completa y después calcula dimensiones reducidas sin redimensionar los bytes (`AfterEffectsBridge.jsx:110-114`).
- Premiere llama a `exportFramePNG` a resolución completa y reporta dimensiones escaladas (`apps/premiere-uxp/src/index.ts:62-64`).

El consumidor puede recibir, por ejemplo, un PNG 4K mientras el envelope afirma 1024 px. Esto rompe la integridad de metadatos, impide controlar coste/latencia y puede superar `maxFrameBytes`. El schema `PreviewCaptureData` solo exige Base64 no vacío y no establece límite ni valida firma, MIME o dimensiones del fichero (`packages/schemas/src/index.ts:19-21`).

**Condición de cierre:** redimensionar realmente, o declarar dimensiones reales y aplicar un encoder/downsampler posterior; rechazar capturas cuyo tamaño serializado exceda el límite negociado; validar firma y dimensiones del fichero decodificado.

### B4 — El Gateway no produce el formato exacto solicitado y duplica el payload visual

**Severidad: alta.**

`mcpToolResult` crea primero el bloque de texto y añade después la imagen (`apps/gateway/src/index.ts:18-24`). El requisito auditado es `content: [{ type: "image", data, mimeType }, { type: "text", text }]`.

El texto se genera con `JSON.stringify(value)` antes de extraer la imagen. En una captura, esto incluye el mismo `imageBase64` completo dentro del envelope textual y otra vez en el bloque `image`. La duplicación aumenta memoria, salida stdio y latencia, y hace que una respuesta que cabía entre daemon y gateway pueda exceder límites del cliente MCP.

Sí se conserva correctamente el envelope lógico: éxito `{ok:true,data}` y fallo `{ok:false,error}`; el catálogo lo valida de forma estricta (`packages/tool-catalog/src/index.ts:18-25`) y `tools/call` marca fallos con `isError` (`apps/gateway/src/index.ts:24,59`). Sin embargo, no hay test del caso imagen ni del orden de bloques.

**Condición de cierre:** emitir imagen primero, texto después, y serializar en texto un envelope seguro sin duplicar el blob (por ejemplo, metadata con el campo Base64 omitido y una indicación explícita de que la imagen viaja en `content`). Añadir tests de éxito visual, error, orden, MIME y ausencia de duplicación.

### B5 — No puede certificarse estabilidad e inmutabilidad de IDs en los cuatro hosts

**Severidad: alta.**

- **Photoshop:** capas y documento usan IDs numéricos nativos (`apps/photoshop-uxp/index.js:35,56,73`). No existe UUID persistente propio, almacenamiento de mapeo ni prueba de reapertura. El `instanceId` se deriva solo de la versión de Photoshop (`index.js:181`), por lo que no representa una instalación/instancia única.
- **Illustrator:** se prefieren `uuid`/`id`; como fallback, `inspect` escribe un marcador en `object.note` (`apps/illustrator-uxp/index.js:62,67,70`). Esto convierte una lectura R0 en una mutación del documento, reemplaza notas existentes y solo persiste si el documento se guarda. Objetos sin `note`, `uuid` o `id` fallan. No hay migración, namespace preservando contenido ni test de guardar/reabrir.
- **After Effects:** composiciones/capas usan el `item.id` host (`AfterEffectsBridge.jsx:32-56`), pero el proyecto se identifica por hash de ruta y todo proyecto sin guardar comparte `project-unsaved` (`:31`). Un Save As cambia el ID del proyecto; múltiples proyectos sin guardar colisionan. No hay pruebas de importación, duplicación o reapertura.
- **Premiere:** al faltar un host concreto no hay generación/resolución de IDs de proyectos, secuencias, pistas, clips, marcadores o elementos. Los tests usan literales ficticios (`project-1`, `track-1`, `clip-1`) y no prueban identidad host.

**Condición de cierre:** definir invariantes por tipo de entidad y host, usar IDs host documentados como persistentes o UUID almacenados sin destruir metadata del usuario, y ejecutar pruebas de reordenación, renombrado, reconexión, guardado/reapertura, Save As, duplicación e importación.

## Otros hallazgos relevantes

### A1 — `adobe.system.status` muestra sesiones, pero el `sessionId` no es el de autenticación

`connectedSessions()` excluye correctamente placeholders `*-unavailable` y devuelve descriptor, salud y capabilities (`packages/bridge-core/src/index.ts:30-33`). El handler expone app, transporte, instanceId, sessionId, versión, pid, salud y capabilities (`apps/daemon/src/index.ts:77`). Esta mejora sí hace visibles las conexiones reales.

No obstante, el handshake crea `sessionId` en `attach` (`apps/daemon/src/index.ts:103-105`), pero al construir `PanelBridge` no lo pasa en el descriptor (`:108`). El constructor genera otro UUID (`:18`). El estado publicado no permite correlacionar la sesión autenticada con logs o incidentes.

También se ignoran `target` e `includeBridges` aceptados por el schema de `adobe.system.status` (`packages/tool-catalog/src/index.ts:49`), de modo que el contrato de entrada no modifica la respuesta. Una reconexión con el mismo `instanceId` puede sobrescribir el bridge en el mapa y el cierre del socket antiguo puede desregistrar el nuevo (`apps/daemon/src/index.ts:107-108`; `packages/bridge-core/src/index.ts:26-27`).

### A2 — F1 está incompleta sin `adobe.verify.visual`

La propuesta incluye `adobe.verify.visual` tanto en la sección 2.1 como en la definición de F1. No existe registro, schema, handler ni implementación fuera de `OPUS_FEATURE_PROPOSAL.md`. En consecuencia, aun corrigiendo `adobe.preview.capture`, F1 no estaría completa según su propio alcance.

### A3 — Falta limpieza de temporales y evidencia de confidencialidad

After Effects intenta eliminar el PNG temporal, pero Illustrator crea el archivo de preview en el data folder y no lo elimina (`apps/illustrator-uxp/index.js:79`). La abstracción Premiere tampoco define eliminación. Los previews pueden contener material sensible; deben eliminarse en `finally`, con nombres impredecibles y política explícita de retención.

### A4 — Las capabilities declaradas no se hacen cumplir al despachar herramientas

El catálogo declara `requiredCapabilities`, pero `routeRpc` no llama a `CapabilityRegistry.require` antes del handler (`apps/daemon/src/index.ts:112-151`). `adobe.preview.capture` requiere únicamente `state.read@1` en el catálogo (`packages/tool-catalog/src/index.ts:50`), no `preview.capture@1`. Esto permite seleccionar una sesión que anuncia lectura pero no captura y descubrir el fallo tarde, en el host.

## Aspectos positivos confirmados

- Los schemas de preview están registrados y el manifest generado está sincronizado.
- El catálogo expone `adobe.preview.capture` como R0 con input/output tipados.
- El daemon envuelve resultados y errores y valida ambos contra el output de la herramienta.
- El Gateway valida input y output antes de exponerlos.
- La autenticación daemon/panel usa challenge-HMAC, nonce de un solo uso, loopback y allowlist de origen.
- Photoshop implementa una captura en memoria con `imaging.getPixels` y aplica `targetSize`.
- Illustrator y After Effects cuentan con código de exportación real, aunque requieren las correcciones descritas.
- `adobe.system.status` ya no presenta placeholders desconectados como sesiones activas.

## Cobertura mínima exigida para recertificación

1. Test Gateway de `tools/call` que verifique exactamente `image` → `text`, `mimeType`, envelope sin blob duplicado e `isError`.
2. Test WebSocket E2E daemon ↔ cada panel, incluida autenticación y captura.
3. Por host: decodificar bytes, validar magic bytes PNG/JPEG, MIME, dimensiones reales, frame/tiempo solicitado y revisión.
4. Capturas de documentos 4K/8K y alta complejidad, verificando límite de frame, memoria y ausencia de temporales.
5. Medición p50/p95/p99 por host con umbral aprobado; hoy no existe evidencia p95.
6. Suite de identidad estable con rename/reorder/reconnect/save/reopen/Save As/duplicate/import.
7. Tests de `adobe.system.status` para varias sesiones, filtro por target, `includeBridges:false`, correlación del sessionId autenticado y reconexión con el mismo instanceId.
8. Implementación y pruebas de `adobe.verify.visual`, o modificación formal y aprobada del alcance de F1.

## Decisión final

**F0: parcialmente implementada, no certificable.** El envelope tipado y la visibilidad básica existen, pero el formato visual del Gateway y las garantías de identidad/sesión no cumplen completamente.

**F1: incompleta y no certificable.** Photoshop ofrece la ruta más cercana a producción; Illustrator requiere corrección de escalado y temporales; After Effects está bloqueado por incompatibilidad de framing; Premiere carece de integración ejecutable; `adobe.verify.visual`, fidelidad y p95 no están implementados/demostrados.

La certificación podrá emitirse cuando se cierren B1–B5 y se aporte evidencia host/E2E para la matriz anterior. Hasta entonces, desplegar F0/F1 como funcionalidad de producción implicaría riesgos de indisponibilidad, metadatos visuales incorrectos, consumo de recursos no acotado, residuos de imágenes sensibles e identidad de entidades no confiable.
