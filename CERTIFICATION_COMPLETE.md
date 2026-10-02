# Auditoría de Certificación Completa — Fases F2, F3 y F4

**Proyecto:** `D:\mcp\adobe-mcp`  
**Fecha de auditoría:** 2026-10-02 (Europe/Madrid)  
**Alcance:** Premiere Pro, Photoshop, After Effects, Illustrator e infraestructura F3/F4  
**Método:** revisión estática de fuentes y contratos, trazado MCP → daemon → bridge → host, revisión de pruebas y ejecución de las tres verificaciones solicitadas.

## 1. Dictamen ejecutivo

**VEREDICTO FINAL: NO CERTIFICADO para F2, F3 y F4 completas.**

El repositorio compila y todas las pruebas automatizadas existentes terminan correctamente. También contiene una base apreciable: contratos Zod estrictos, transportes autenticados, validación de revisiones e idempotencia en varios bridges, builders tipados, primitivas puras, almacenamiento content-addressed y un ejecutor de sagas con compensación inversa.

Sin embargo, el estado comprobado no permite certificar las funcionalidades solicitadas de extremo a extremo. Los bloqueos principales son:

1. Las herramientas especializadas `adobe.photoshop.exportLayers`, `adobe.illustrator.exportArtboards`, `adobe.aftereffects.preset.apply` y `adobe.premiere.editPlan.execute` se publican en el catálogo, pero el daemon las enruta por handlers genéricos incompatibles. En los dos primeros casos se exporta el documento genérico y la salida no satisface el contrato especializado; en los dos últimos se construye una mutación con `commands` inexistente.
2. Premiere no implementa el Timeline DOM en el host UXP. `DefaultUxpPremiereHost` delega las operaciones a un `runtime.invoke` opcional que no forma parte de una integración concreta. La captura usa una interfaz local `sequence.exportFramePNG(...)` distinta de la API UXP pública de Premiere.
3. El motor `EditPlan` tiene un defecto funcional grave: `autoReframe` se transforma en `setAudioKeyframes` sobre el clip ficticio `__auto-reframe__`. Las transiciones tampoco se aplican en el simulador de Timeline.
4. Los builders `batchPlay` de Photoshop no son ejecutables por el panel: el bridge llama `photoshop.batchPlay`, pero `apps/photoshop-uxp/index.js` no expone ese método. `exportLayers` solo construye un manifiesto sobre bytes ya suministrados; no exporta capas desde Photoshop ni persiste artefactos.
5. El catálogo de presets de After Effects existe como funciones internas, pero el servidor MCP no anuncia ni implementa `resources/list` o `resources/read`, y el panel JSX no implementa `adobe.aftereffects.preset.apply`.
6. La ruta productiva de render de After Effects no usa segmentación. El helper `renderFarm` no ensambla resultados y calcula el hash sobre una ruta final que los chunks no generan. Además, el argumento de render settings se emite como `-r`; la CLI oficial usa `-RStemplate`.
7. Las primitivas vectoriales, tipografía y exportación multi-artboard de Illustrator están aisladas del bridge y del host. El host UXP solo acepta el conjunto antiguo `IllustratorEditCommand` y exporta un documento completo.
8. El `ArtifactStore` funciona de forma aislada, pero no está integrado en los pipelines auditados; además puede devolver metadatos nuevos para bytes ya existentes aunque conserve en disco los metadatos de la primera escritura.
9. La saga compensa en orden inverso, pero su idempotencia no está aislada por transacción, el log solo vive en memoria y los fallos de compensación se descartan sin evidencia detallada.

Los tests verdes acreditan los casos que ejercitan, pero no refutan estos hallazgos: gran parte de F2–F4 solo tiene pruebas de builders o matemáticas puras, no pruebas del camino MCP/daemon/host.

## 2. Criterio y estados de conformidad

- **Conforme:** implementación conectada y verificada de forma suficiente para el alcance.
- **Parcial:** existe una parte útil, pero falta integración, validación o cobertura necesaria.
- **No conforme:** el camino solicitado no es ejecutable o contiene un defecto que invalida el resultado.
- **No verificado en host:** solo existe prueba simulada/estática; no se ejecutó Adobe real.

## 3. Matriz de conformidad

| Área | Requisito | Estado | Evidencia principal |
|---|---|---:|---|
| Premiere | Bridge, allowlist, revisión, snapshots e idempotencia | Parcial | `packages/bridge-premiere/src/index.ts:35-145,185-215`; pruebas de fallback y mutación en `index.test.ts:29-57`. |
| Premiere | Panel UXP autenticado | Parcial | Handshake y allowlist en `apps/premiere-uxp/src/index.ts:171-238`; no hay test de handshake/panel completo. |
| Premiere | Host UXP real | No conforme | `DefaultUxpPremiereHost` delega a `runtime.invoke` opcional (`:78-91`) y modela `exportFramePNG` en una interfaz local (`:53`). |
| Premiere | `splitClip`, `moveClip`, `trimClip`, `rippleDelete` | Parcial | Builders y simulador en `edit-plan.ts:59-70,120-143`; el host no los ejecuta y solo split/ripple tienen test. |
| Premiere | Transiciones | No conforme | Builder en `edit-plan.ts:71-73`, pero `applyTimelineOperation` cae al retorno sin cambios (`:147`). |
| Premiere | Keyframes de audio | Parcial | Builder/aplicación en `edit-plan.ts:74-76,144`; sin host real ni prueba específica. |
| Premiere | `addCaptionTrack` | Parcial | Builder/aplicación de estado en `edit-plan.ts:80-82,146`; sin creación de pista host ni test. |
| Premiere | `cutSilences` | Parcial | Expande rangos a ripple delete (`edit-plan.ts:96-98`), pero ignora `ripple: false` y no realiza análisis host. |
| Premiere | `autoDucking` | Parcial | Cálculo determinista (`edit-plan.ts:41-50`) y expansión (`:98-103`); no fusiona solapes ni tiene integración/test host. |
| Premiere | `autoReframe` 9:16 | No conforme | Se convierte erróneamente en keyframes de audio sobre `__auto-reframe__` (`edit-plan.ts:104-106`). |
| Photoshop | Bridge UXP/COM | Parcial | Autenticación y revisión presentes (`bridge-photoshop/src/index.ts:67-182`); respuestas principales se aceptan mediante cast sin validación de salida. |
| Photoshop | Builders tipados `batchPlay` | Parcial | Esquemas/builders en `batchplay.ts:11-47`; propiedades internas siguen siendo `Record<string, unknown>` y no hay validación host de los descriptores. |
| Photoshop | Ejecución `batchPlay` en panel | No conforme | El bridge llama `photoshop.batchPlay` (`index.ts:184-187`); `apps/photoshop-uxp/index.js:165-173` no lo enruta. |
| Photoshop | Máscaras, ajustes, Smart Objects, filtros seguros | Parcial | Builders existen (`batchplay.ts:16-45`), pero no llegan al host; IDs de capa se tipan como string aunque UXP documenta IDs numéricos. |
| Photoshop | `adobe.photoshop.exportLayers` + SHA-256/procedencia | No conforme | `exportLayers` solo hashea bytes recibidos (`batchplay.ts:49-59`); el daemon lo manda a export genérico (`apps/daemon/src/index.ts:78,92`). |
| After Effects | Bridge TCP JSON-lines autenticado | Conforme a nivel de transporte simulado | `bridge-aftereffects/src/index.ts:50-123`; test TCP real local en `index.test.ts:63-110`. |
| After Effects | Panel JSX inspección/mutación/render queue | Parcial | Handlers en `AfterEffectsBridge.jsx:75-159`; faltan preset, restore y cancel. No existe test ejecutable del panel. |
| After Effects | Catálogo, MatchNames y recetas | Parcial | Catálogo en `presets.ts:3-19`; algunas entradas son recetas conceptuales, no efectos aplicables, y no hay aplicación host. |
| After Effects | MCP `resources/list` / `resources/read` | No conforme | El gateway solo declara tools (`apps/gateway/src/index.ts:60-68`); no existen handlers MCP de resources. |
| After Effects | `adobe.aftereffects.preset.apply` | No conforme | El bridge dispone de helper (`presets.ts:21-26`), pero daemon y panel no implementan su ruta especializada. |
| After Effects | `aerender` seguro sin shell | Parcial | `spawn(..., shell:false, windowsHide:true)` en `aerender.ts:163-174`; hay test simulado. |
| After Effects | Chunks/lotes + SHA-256 | No conforme | Helper secuencial aislado (`aerender.ts:75-87`); la exportación real llama `worker.run`, no `renderFarm` (`index.ts:228-235`). |
| Illustrator | Bridge, manifest JSX e integridad | Conforme a nivel de bridge | Hash/allowlist en `bridge-illustrator/src/index.ts:78-125`; pruebas `index.test.ts:72-86`. |
| Illustrator | Primitivas, trazados y pathfinders | No conforme E2E | Builders en `vector.ts:7-10`; no pertenecen a `IllustratorEditCommand` ni se implementan en el host UXP. |
| Illustrator | Tipografía | No conforme E2E | `IllustratorTextSpec` y builder existen, pero no hay comando/handler que lo aplique. |
| Illustrator | Multi-artboard con downscaling | No conforme E2E | Helper correcto en `vector.ts:25-39`; el daemon usa export genérico y el host exporta todo el documento. |
| F3 | Artifact store content-addressed | Parcial | SHA-256, `wx`, resolve y verificación en `artifact-store/src/index.ts:9-35`; no está integrado en exports/renders. |
| F3 | Presets/LUTs compartidos | Parcial | Hash y catálogo en `presets/src/index.ts`; LUTs contienen `values: []`, por lo que no son LUTs utilizables. |
| F4 | Saga cross-app e idempotencia | Parcial | Ejecución y compensación inversa en `workflow-engine/src/saga.ts:15-34`; claves no incluyen `transactionId` y log volátil. |
| F4 | Flujo creativo cross-app ejecutable | No conforme | Los cuatro pasos predefinidos (`saga.ts:37-43`) apuntan a herramientas especializadas que no tienen rutas daemon/host correctas. |

## 4. Evidencia técnica y hallazgos

### 4.1 Hallazgos bloqueantes

#### B1 — Dispatcher del daemon incompatible con herramientas especializadas

**Severidad: bloqueante.**

`apps/daemon/src/index.ts:76-78` define únicamente handlers genéricos de lectura, mutación y exportación. En `:92-95` reutiliza esos handlers para cuatro herramientas cuyos contratos no tienen la misma forma:

- `adobe.photoshop.exportLayers` y `adobe.illustrator.exportArtboards` pasan por `exportTool`. El daemon llama `bridge.export(...)`, no los helpers `exportLayers(...)` o `exportArtboards(...)`. La salida real `{artifact, receipt}` no coincide con los contratos `{manifest, artifacts}` de `packages/tool-catalog/src/index.ts:67,74`.
- `adobe.aftereffects.preset.apply` y `adobe.premiere.editPlan.execute` pasan por `mutate`. El handler lee `input.commands` (`daemon/index.ts:77`), aunque esos contratos contienen respectivamente `presetId/layerId` y `operations`. Por tanto construye una mutación inválida y tampoco llama `AfterEffectsBridge.applyPreset` ni `PremiereBridge.executeEditPlan`.

Este defecto invalida también la saga predefinida, porque sus cuatro pasos usan exactamente esas herramientas (`workflow-engine/src/saga.ts:39-42`).

**Condición de cierre:** handlers especializados con validación de entrada/salida y tests contractuales que recorran gateway → daemon → panel simulado para cada herramienta.

#### B2 — Premiere Timeline no tiene implementación host real

**Severidad: bloqueante.**

`apps/premiere-uxp/src/index.ts:65-91` implementa inspección y preview, pero todas las mutaciones reales terminan en `runtime.invoke`. El repositorio no define un runtime que lo proporcione ni adapta las clases públicas de Premiere. La interfaz `PremiereFrameSequence` añade métodos propios `exportFramePNG`/`exportFrameJPEG` (`:53`). La documentación oficial actual expone la captura mediante `Exporter.exportSequenceFrame(sequence, time, filename, filepath, width, height)`, no como método de `Sequence` ([Adobe Premiere UXP — Exporter](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/exporter)).

Además, el manifest admite Premiere 24 (`apps/premiere-uxp/manifest.json`), mientras que `Exporter.exportSequenceFrame` figura desde 25.6. Incluso sustituyendo la interfaz, sería necesario elevar versión mínima o implementar una ruta compatible.

El descriptor del bridge anuncia transiciones, audio keyframes, captions y EditPlan (`bridge-premiere/src/index.ts:126-133`), pero el panel UXP no anuncia esas capacidades (`apps/premiere-uxp/src/index.ts:9-14`).

**Condición de cierre:** adapter sobre API UXP pública/versionada, operaciones Timeline reales, capacidades negociadas coherentes y tests host o harness contractual fiel a la API.

#### B3 — `autoReframe` genera comandos de audio

**Severidad: bloqueante.**

`packages/bridge-premiere/src/edit-plan.ts:104-106` traduce cada operación `autoReframe` a:

```ts
{ op: "setAudioKeyframes", clipId: "__auto-reframe__", ... }
```

Esto no representa posición/escala/crop de vídeo y no puede producir un reencuadre 9:16. Es una transformación semánticamente incorrecta, no una implementación parcial.

También hay defectos secundarios:

- `cutSilences` siempre genera `rippleDelete`, aunque el contrato permite `ripple: false` (`edit-plan.ts:96-98`).
- `applyTransition` no tiene rama en `applyTimelineOperation`; devuelve el estado intacto (`:147`).
- `trimClip` reemplaza directamente `startTime/endTime` sin distinguir puntos de fuente y de timeline (`:131`).
- `moveClip`, trim y keyframes no fallan si el clip no existe.
- Los keyframes de ducking pueden duplicarse/contradecirse en rangos solapados (`:41-50`).

#### B4 — Photoshop `batchPlay` y exportación de capas no llegan al host

**Severidad: bloqueante.**

El bridge expone `executeBatchPlay()` y envía `photoshop.batchPlay` (`bridge-photoshop/src/index.ts:184-187`), pero `apps/photoshop-uxp/index.js:165-173` solo acepta métodos `bridge.*`. Por tanto los builders no son ejecutables por la integración entregada.

La API oficial espera una lista de Action Descriptors y opciones como segundo argumento, dentro de ámbito modal para mutaciones ([Adobe Photoshop UXP — batchPlay](https://developer.adobe.com/photoshop/uxp/ps_reference/media/batchplay/)). Los objetos del builder envuelven cada descriptor en `{action, descriptor, options}`; no existe adaptación en el panel que extraiga descriptores, agrupe opciones y examine resultados `_obj: "error"`.

`buildLayerExportManifest` (`batchplay.ts:54-57`) sí calcula SHA-256 de bytes, pero recibe esos bytes del llamador. No selecciona capas, no exporta PNG/PSD, no escribe archivos, no registra `artifact://...` y no verifica los bytes persistidos. El artefacto de manifiesto solo registra `{app:"photoshop"}` como procedencia, sin `sourceDocumentId` ni relación explícita con artefactos de capa.

#### B5 — Presets de After Effects no son recursos MCP ni son aplicables

**Severidad: bloqueante.**

`listAfterEffectsPresetResources` y `readAfterEffectsPresetResource` (`bridge-aftereffects/src/presets.ts:18-19`) son funciones locales. `GatewayServer.initialize` anuncia únicamente `tools` y `handle` carece de `resources/list` y `resources/read` (`apps/gateway/src/index.ts:60-68`). En consecuencia, un cliente MCP no puede descubrir ni leer el catálogo.

`applyAfterEffectsPreset` envía `adobe.aftereffects.preset.apply` (`presets.ts:21-26`), pero `AfterEffectsBridge.jsx:148-159` no admite ese método. Varias entradas son recetas conceptuales y no MatchNames de efectos aplicables (`ADBE Wiggle`, `ADBE Expression`, `ADBE Camera`, `ADBE Motion Blur`), y el panel no transforma recetas en propiedades, expresiones, rigs o efectos.

El `presetHash` local (`presets.ts:14`) es un FNV-1a de 32 bits repetido ocho veces, no SHA-256. Aunque el esquema de preset de AE no exige SHA-256, el nombre `fingerprint` no debe usarse como evidencia criptográfica.

#### B6 — Render headless/chunks/hash no forma una ruta productiva válida

**Severidad: bloqueante.**

Puntos positivos: búsqueda allowlisted, `spawn` sin shell, argv separado, captura de progreso, cancelación y límites inyectables (`aerender.ts:90-224`). No obstante:

- `buildAerenderArgs` usa `-r` para `settingsTemplate` (`aerender.ts:133`). La documentación oficial usa `-RStemplate` ([Adobe After Effects — automated rendering](https://helpx.adobe.com/th_en/after-effects/desktop/render-and-export/automate-rendering/automated-rendering-network-rendering.html)).
- `AfterEffectsBridge.exportWithAerender` llama una sola vez a `AerenderWorker.run` (`index.ts:228-235`); no consume un `AfterEffectsRenderPlan` ni `renderFarm`.
- `renderFarm` genera nombres de salida por segmento (`aerender.ts:80-83`), pero después calcula SHA-256 sobre `request.outputPath` (`:84-86`), que no es ninguno de esos nombres. No ensambla archivos ni define un manifiesto de secuencia.
- `AerenderWorker.run` no verifica que el output exista ni calcula su hash antes de marcar éxito (`:196-202`).
- La exportación devuelve un `ArtifactRef` sin `sha256`, `sizeBytes`, URI content-addressed ni procedencia (`bridge-aftereffects/src/index.ts:234`).
- Se devuelve receipt `queued` después de haber esperado la terminación de `run`, incluso si el job quedó `succeeded` o `failed` (`:232-235`).

#### B7 — Illustrator: builders aislados, host sin pathfinders/tipografía/artboards

**Severidad: bloqueante.**

`vector.ts` implementa builders y matemáticas correctas, pero `IllustratorBridge.mutate` valida exclusivamente `IllustratorEditCommand` (`bridge-illustrator/src/index.ts:173-180`). Ese esquema no incluye `create-path`, `compound-path`, `boolean` ni tipografía (`schemas/src/index.ts:48-53` frente a `:150-156`).

El host UXP acepta solo `create-layer`, `create-item`, `transform` y `delete` (`apps/illustrator-uxp/index.js:75-76`). No implementa compound paths, pathfinders ni formato tipográfico. `exportArtboards` tampoco se llama desde bridge/daemon/panel; el host `export` guarda/exporta el documento completo (`index.js:78`).

El test vectorial solo comprueba que un builder devuelve un objeto y que una fórmula da 500×250 (`bridge-illustrator/src/index.test.ts:89-93`); no prueba `exportArtboards`, bytes, hashes o dimensiones decodificadas.

### 4.2 Hallazgos altos

#### A1 — Artifact store: correcto en aislamiento, no integrado y con metadatos ambiguos

`ArtifactStore` usa SHA-256, rutas derivadas del digest, escritura `wx`, URI estricta y reverificación al leer (`artifact-store/src/index.ts:9-35`). Es una buena base content-addressed.

No obstante, una segunda llamada `put()` con los mismos bytes y distinta procedencia/media type crea y devuelve metadatos nuevos en memoria (`:20-31`) aunque el `.json` existente se conserva por `EEXIST`. El retorno puede no coincidir con lo que posteriormente devuelve `get()`. La semántica inmutable debería devolver los metadatos canónicos existentes o rechazar el conflicto. Tampoco hay rollback si se escribe el blob pero falla permanentemente el metadata, ni prueba de corrupción, deduplicación concurrente o conflicto de metadatos.

Ninguna de las rutas productivas de exportación auditadas escribe en `ArtifactStore`; por tanto `artifact://sha256-...` no es la forma real de intercambio cross-app actual.

#### A2 — Presets/LUTs compartidos no contienen LUTs funcionales

`packages/presets/src/index.ts` calcula SHA-256 y verifica el payload canónico. Sin embargo, ambos presets LUT declaran tamaño 33 y `values: []` (`:6-7`): no contienen los 33³ valores necesarios ni una referencia a un artefacto `.cube`. Son metadatos de placeholder, no LUTs aplicables.

La prueba (`index.test.ts:4`) solo comprueba cantidad, lookup y hash; no valida estructura por tipo, cardinalidad, rangos ni consumo desde aplicaciones.

#### A3 — Saga: idempotencia global/volátil y compensaciones opacas

`executeSaga` compensa en orden inverso correctamente (`workflow-engine/src/saga.ts:27-33`), y la prueba lo cubre de forma básica. Persisten estos riesgos:

- `SagaTransactionLog` indexa solo por `step.idempotencyKey`; `transactionId` no participa (`:7-13,20-22`). Dos transacciones que usen la saga predefinida compartirán claves `creative-assembly:*` y la segunda se considerará ya aplicada.
- Un paso `already-applied` se añade a `applied` (`:21`) y puede compensarse si un paso posterior falla, incluso si procedía de otra transacción.
- El log es exclusivamente memoria; no permite recuperación tras reinicio.
- Las excepciones de compensación se descartan (`:31`), sin resultado por compensación, error ni estrategia de reintento.
- El status `failed` no distingue fallo de ejecución de rollback parcial.

#### A4 — Resultados host aceptados con validación insuficiente

Photoshop y After Effects convierten varias respuestas con casts (`bridge-photoshop/src/index.ts:174,199`; `bridge-aftereffects/src/index.ts:193-207`) en vez de validar `OperationReceipt`, `ArtifactRef` y `Job` con Zod. Un host defectuoso puede introducir una estructura inválida hasta capas posteriores.

Photoshop además guarda idempotencia en el panel solo por `operationId`, sin hash de input (`apps/photoshop-uxp/index.js:103-125`). Reutilizar el ID con entrada diferente devuelve silenciosamente el resultado anterior. El bridge Node sí detecta el conflicto, pero el panel debería preservar la misma garantía si recibe llamadas por otra ruta.

### 4.3 Hallazgos medios y deuda de pruebas

1. `detectSilenceRanges` concatena muestras silenciosas aunque haya huecos temporales entre ellas; no valida orden/continuidad (`edit-plan.ts:28-38`).
2. `calculateAutoReframeKeyframes` no valida `time`/`centerX` ni ordena/suaviza muestras (`edit-plan.ts:53-57`).
3. Premiere valida dimensiones reales de previews en el bridge, pero el panel no lo hace antes de reportarlas; el test del panel usa una API simulada creada por el propio repositorio.
4. Photoshop UXP exporta documentos sin SHA-256 (`apps/photoshop-uxp/index.js:138-148`) y su `test` solo valida estructura del bundle.
5. After Effects panel declara un script de test que siempre devuelve éxito (`apps/aftereffects-panel/package.json`).
6. Illustrator UXP usa `node --check` como test/typecheck; no verifica comportamiento (`apps/illustrator-uxp/package.json`).
7. No hay pruebas de gateway para `resources/*`, herramientas especializadas, saga E2E, corrupción de artefactos, chunks de render o compatibilidad con runtimes Adobe.
8. No se ejecutó una aplicación Adobe real en esta auditoría; todos los resultados host son simulados o estáticos.

## 5. Revisión por producto

### 5.1 Premiere Pro

**Fortalezas comprobadas**

- Allowlist RPC, Zod por familia de comando y fallback UXP→CEP limitado a errores de disponibilidad.
- Snapshot content-addressed, revisión esperada e idempotencia con hash en `PremiereBridge`.
- Validación de dimensiones codificadas de preview y limpieza de temporales en el handler simulado.
- Matemáticas deterministas para split, move, trim, ripple y keyframes.

**Resultado:** **no conforme** para F2/F4 completa. El bridge de control es razonable, pero el host Timeline y los motores avanzados no son productivos. Ocho tests del bridge y dos del panel pasan; solo cubren split/ripple/cutSilences y preview, no el conjunto pedido.

### 5.2 Photoshop

**Fortalezas comprobadas**

- Transporte autenticado, fallback COM explícito, revisiones e idempotencia en Node.
- Builders con esquemas para categorías solicitadas y modo de diálogo silencioso.
- Cálculo SHA-256 determinista del manifiesto aislado.

**Resultado:** **no conforme** para el alcance F2/F3. Los builders no tienen endpoint host y el pipeline `exportLayers` no existe como exportación real. Tres tests del bridge pasan; ninguno prueba `exportLayers` ni ejecuta descriptores contra el panel.

### 5.3 After Effects

**Fortalezas comprobadas**

- Transporte TCP JSON-lines probado con fragmentación, autenticación previa y nonces.
- Panel JSX con inspección, mutaciones allowlisted, render queue y preview con limpieza.
- Worker `aerender` sin shell, allowlist de ejecutable, progreso y cancelación.

**Resultado:** **no conforme** para catálogo MCP/presets y render headless por chunks con SHA-256. Ocho tests pasan, pero `renderFarm` no se prueba y el panel tiene test vacío.

### 5.4 Illustrator

**Fortalezas comprobadas**

- Bridge validado, fallback JSX con manifest/hash y buena higiene de allowlist.
- Fórmula de downscaling y manifiesto de hashes bien estructurados como funciones puras.

**Resultado:** **no conforme** para primitivas/pathfinders/tipografía/export multi-artboard integrados. Seis tests pasan; solo uno toca el nuevo alcance vectorial y no ejecuta un host.

## 6. Ejecución de tests solicitada

| Comando | Resultado | Evidencia resumida |
|---|---:|---|
| `pnpm turbo run test typecheck --force` | **PASS (exit 0)** | Turbo: **54 tareas correctas de 54**, 0 cacheadas, ~14.4 s. Bridges: Premiere 8 tests, Photoshop 3, After Effects 8, Illustrator 6; Premiere UXP 2. |
| `pnpm test:contract` | **PASS (exit 0)** | Turbo: **22 tareas correctas de 22**. La ejecución reutilizó caché para las 22 tareas y reemitió logs previos. |
| `pnpm schemas:check` | **PASS (exit 0)** | `@adobe-mcp/schemas schemas:check`; generación comprobada sin diferencias. |

### Interpretación

Los comandos solicitados pasan y no hay errores TypeScript detectados. Esto certifica consistencia interna de las pruebas existentes y de los esquemas generados, pero no certifica el comportamiento no cubierto. En particular:

- `apps/aftereffects-panel` ejecuta `node -e "process.exit(0)"` como test.
- `apps/illustrator-uxp` ejecuta solo `node --check index.js`.
- `apps/photoshop-uxp` ejecuta un validador estático propio.
- Los tests de bridge usan transports/hosts falsos y no recorren las cuatro herramientas especializadas a través del daemon.

## 7. Plan mínimo de remediación para recertificar

1. Crear handlers dedicados en daemon para exportLayers, exportArtboards, preset.apply y editPlan.execute; añadir métodos equivalentes a `AdobeBridge` o interfaces de extensión tipadas.
2. Implementar Premiere sobre las clases UXP públicas de la versión mínima soportada; realizar split/move/trim/ripple/transitions/audio/captions y reframe de vídeo reales. Eliminar la traducción de reframe a audio.
3. Exponer `photoshop.batchPlay` en el panel con adaptación descriptor/opciones, `executeAsModal`, inspección de errores por resultado y tests de descriptors grabados/verificados. Implementar export de capa/grupo real y persistencia en ArtifactStore.
4. Añadir `resources` a `initialize` y handlers `resources/list`/`resources/read`. Convertir cada preset AE en comandos host concretos y usar MatchNames verificados.
5. Corregir `-RStemplate`; hacer que export aerender consuma planes segmentados, verifique cada output, cree manifiesto/hashes, defina ensamblado o secuencia y solo marque éxito tras comprobación.
6. Integrar las operaciones vectoriales/tipografía en el esquema de mutación de Illustrator y en UXP/JSX. Conectar exportArtboards al daemon y verificar dimensiones reales de PNG/SVG.
7. Integrar ArtifactStore en todos los exports y snapshots, devolver URI/digest/procedencia canónicos y resolver el conflicto de metadatos para blobs existentes.
8. Aislar la idempotencia de saga por `(transactionId, stepKey)`, persistir el log y registrar/reintentar fallos de compensación.
9. Añadir pruebas E2E de contrato para cada herramienta especializada y pruebas host/harness de APIs Adobe; hacer no vacíos los tests de panel.

## 8. Decisión formal

### Fase F2

**No certificada.** Existen contratos, bridges y primitivas valiosas, pero faltan implementaciones host reales en Premiere/Illustrator, ejecución de batchPlay/exportLayers en Photoshop y aplicación de presets en After Effects.

### Fase F3

**No certificada.** ArtifactStore y presets compartidos pasan sus pruebas unitarias, pero no están integrados en los pipelines; las LUTs son placeholders y los recursos AE no se publican por MCP.

### Fase F4

**No certificada.** La saga básica compensa en orden inverso, pero sus pasos apuntan a rutas no funcionales, la idempotencia no está aislada por transacción y el render segmentado con SHA-256 no forma parte del flujo productivo.

**Conclusión:** el repositorio puede aceptarse como base de desarrollo con contratos y scaffolding avanzados, pero **no como entrega certificada completa de F2, F3 y F4**. Se requiere cerrar B1–B7 y repetir esta matriz con pruebas E2E y evidencia de host.
