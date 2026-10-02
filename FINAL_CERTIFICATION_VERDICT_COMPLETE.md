# Dictamen final de certificación de la remediación B1–B9

**Proyecto:** `D:\mcp\adobe-mcp`  
**Fecha:** 2026-10-02 (Europe/Madrid)  
**Objeto:** revisión en profundidad de las remediaciones B1–B9 identificadas en `CERTIFICATION_COMPLETE.md`  
**Método:** trazado estático de contratos y rutas gateway → daemon → bridge/panel → host, revisión de pruebas, ejecución de las verificaciones requeridas y análisis de casos negativos.

## 1. Dictamen ejecutivo

**VEREDICTO FORMAL: REMEDIACIÓN NO CERTIFICADA EN SU CONJUNTO.**

Las correcciones son sustanciales y cierran de forma satisfactoria **B8** y **B9** en el alcance expresamente pedido. También corrigen partes importantes de **B1–B7**: existen handlers especializados en el daemon, `autoReframe` ya produce operaciones de vídeo, se respeta `ripple: false`, las transiciones se modelan, Photoshop expone `batchPlay` modal, el Gateway publica recursos MCP, `aerender` usa `-RStemplate`, Illustrator acepta nuevos comandos y los tres comandos de verificación terminan correctamente.

No obstante, permanecen bloqueos de ejecutabilidad de extremo a extremo que impiden certificar la remediación completa:

1. `adobe.premiere.editPlan.execute` está declarado R3, pero su esquema estricto no admite `plan` ni `approval`; la política del gateway y del daemon exige `input.plan` para R3. La herramienta no puede atravesar válidamente esa política.
2. El dispatcher del daemon llama `bridge.preset.apply` sin añadir el objeto `preset`; el JSX de After Effects necesita `params.preset.recipe`. La ruta daemon → panel falla aunque el bridge específico de AE sí tenga un helper que añade la receta.
3. Premiere sigue sin ejecutar las operaciones Timeline mediante una adaptación concreta a la API UXP: el host por defecto delega en `runtime.timeline`, `sequence.applyOperation` o `runtime.invoke`, todos opcionales y no implementados en el repositorio.
4. Photoshop `exportLayers` intenta obtener `bytesBase64` de un descriptor `get` de capa. No existe una exportación/encoder real que produzca esos bytes; por tanto la persistencia posterior no hace funcional la exportación en un host real.
5. La ruta MCP productiva de After Effects no puede construir el `AerenderRequest` que espera el bridge y el ensamblado de chunks concatena bytes de outputs renderizados, lo que no constituye un ensamblado válido de contenedores de vídeo.
6. Illustrator conecta los comandos nuevos, pero `compound-path` crea un grupo y el supuesto pathfinder agrupa objetos y lanza comandos de menú sin selección ni expansión verificadas. La tipografía omite `kerning`, y no existen pruebas de host que acrediten estos resultados.

Los tests verdes demuestran coherencia interna de los casos ejercitados; no cubren estos fallos de integración.

## 2. Matriz de cierre B1–B9

| Punto | Estado | Dictamen resumido |
|---|---:|---|
| **B1** Dispatcher especializado | **No cerrado** | Los cuatro handlers existen, pero solo los dos exports tienen prueba daemon; `editPlan.execute` es inejecutable por incompatibilidad esquema/política R3 y `preset.apply` no entrega la receta requerida al panel. |
| **B2** Premiere host/capabilities | **No cerrado** | Las capabilities del bridge y panel incluyen transición, audio, captions y EditPlan, pero el host UXP real sigue sustituido por hooks opcionales no implementados. |
| **B3** Semántica EditPlan | **Parcialmente cerrado** | `autoReframe`, `applyTransition` y `ripple: false` están corregidos y probados en el motor puro; no hay ejecución host E2E. |
| **B4** Photoshop | **No cerrado** | `batchPlay` modal/error handling está conectado; `exportLayers` no realiza una exportación real de capa y la persistencia no tiene prueba de integración bridge/panel/ArtifactStore. |
| **B5** Recursos/presets AE | **No cerrado** | `resources/list` y `resources/read` existen y tienen happy-path test; la ruta productiva de preset pierde el catálogo entre daemon y JSX. |
| **B6** `aerender`/chunks/SHA-256 | **No cerrado** | `-RStemplate` y SHA-256 están corregidos, pero el contrato MCP no alimenta `options.request`, el ensamblado por concatenación es inválido y no hay test de `renderFarm`. |
| **B7** Illustrator | **No cerrado** | Contratos y dispatch están ampliados; compound paths/pathfinders/tipografía no implementan fielmente la semántica solicitada y los tests son solo de builders/matemática. |
| **B8** Metadatos de ArtifactStore | **Cerrado** | En deduplicación se devuelve el metadata canónico persistido; existe prueba expresa de metadata conflictivo. |
| **B9** Saga | **Cerrado en el alcance solicitado** | Las claves están aisladas por transacción y se devuelven `compensationErrors`; existe prueba específica. El log continúa siendo volátil, como riesgo residual. |

## 3. Evidencia detallada

### B1 — Dispatcher del daemon

**Correcciones verificadas**

- `apps/daemon/src/index.ts:138-141` define handlers distintos para `exportLayers`, `exportArtboards`, `applyPreset` y `executeEditPlan`.
- `apps/daemon/src/index.ts:156-159` asocia cada herramienta especializada con su handler correcto.
- `apps/daemon/src/index.ts:161` verifica que el dispatcher cubra todo `TOOL_NAMES`.
- `apps/daemon/src/index.test.ts:77-94` recorre por WebSocket real simulado los exports de Photoshop e Illustrator y comprueba SHA-256.

**Bloqueos**

1. No hay pruebas daemon para `adobe.aftereffects.preset.apply` ni `adobe.premiere.editPlan.execute`.
2. `adobe.premiere.editPlan.execute` tiene riesgo R3 (`packages/tool-catalog/src/index.ts:87`). Gateway y daemon exigen `input.plan` para R3 (`apps/gateway/src/index.ts:82`, `apps/daemon/src/index.ts:207-213`), pero `PremiereEditPlan` es estricto y no incluye `plan` ni `approval` (`packages/schemas/src/index.ts:145`). Se confirmó además en ejecución que `validateToolInput` rechaza `plan` como `unrecognized_keys`. Un `approvalToken` dentro de `options` tampoco resuelve la ausencia obligatoria de `input.plan`.
3. `PanelBridge.applyPreset` envía el input validado directamente a `bridge.preset.apply` (`apps/daemon/src/index.ts:85`). El JSX usa `params.preset || {}` y requiere categoría/receta (`apps/aftereffects-panel/src/AfterEffectsBridge.jsx:37-47`). Solo `packages/bridge-aftereffects/src/presets.ts:23-27` añade el preset, pero esa función no participa en la ruta directa daemon → panel.

**Conclusión B1:** la selección de handlers está corregida, pero dos de las cuatro rutas especializadas no son operativas E2E. B1 no puede darse por cerrado.

### B2 y B3 — Premiere Pro

**Correcciones verificadas**

- `autoReframe` se expande a `setVideoTransform` y `setCropKeyframes`, nunca a audio (`packages/bridge-premiere/src/edit-plan.ts:108-118`).
- `cutSilences` con `ripple: false` produce `deleteRange` y conserva los huecos (`edit-plan.ts:100-102,167-175`).
- `applyTransition` valida existencia, pista y continuidad y modifica entrada/salida de los clips (`edit-plan.ts:180-190`).
- Las pruebas comprueban explícitamente vídeo/no-audio, no-ripple y transiciones positivas/negativas (`packages/bridge-premiere/src/index.test.ts:110-126`).
- Bridge y panel anuncian `timeline.transitions@1`, `timeline.audio-keyframes@1`, `timeline.captions@1` y EditPlan (`packages/bridge-premiere/src/index.ts:125-136`; `apps/premiere-uxp/src/index.ts:9-14`).

**Bloqueos y riesgos**

- `DefaultUxpPremiereHost.timelineEdit()` delega en `runtime.timeline.applyOperation`, `sequence.applyOperation` o `runtime.invoke`; `editPlanExecute()` delega igualmente (`apps/premiere-uxp/src/index.ts:80-93`). El repositorio no aporta el adaptador que traduzca esas operaciones al DOM público de Premiere.
- Los dos tests del panel solo cubren preview y limpieza temporal (`apps/premiere-uxp/src/index.test.ts:6-47`); no prueban Timeline, transiciones, transforms/crop ni EditPlan.
- El manifest mantiene `minVersion: 24.0` y el preview sigue modelando `exportFramePNG/JPEG` como métodos locales de secuencia (`apps/premiere-uxp/src/index.ts:53-64,96-109`), sin prueba contra un runtime Adobe real.
- La imposibilidad R3 descrita en B1 bloquea la herramienta pública aunque el motor puro funcione.

**Conclusión B2/B3:** la semántica algorítmica de B3 queda corregida y bien probada; la ejecución host de B2 y el camino público completo siguen abiertos.

### B4 — Photoshop UXP y ArtifactStore

**Correcciones verificadas**

- `photoshop.action.batchPlay` está enrutado por el panel (`apps/photoshop-uxp/index.js:196-206`).
- La ejecución usa `core.executeAsModal`, fuerza ejecución síncrona/modal y examina resultados `_obj: "error"`/error (`index.js:63-75`).
- `PhotoshopBridge.executeBatchPlay()` extrae los descriptores de los builders antes de enviarlos (`packages/bridge-photoshop/src/index.ts:189-193`).
- `PhotoshopBridge.exportLayers()` exige un ArtifactStore, persiste cada byte recibido y devuelve URI/hash/tamaño/procedencia (`index.ts:196-215`). El daemon tiene además un store content-addressed equivalente para respuestas crudas del panel (`apps/daemon/src/index.ts:17-84`).

**Bloqueos**

- El panel no exporta/renderiza la capa. Ejecuta un descriptor `get` y espera que su resultado contenga un campo no estándar `bytesBase64`; si no existe, lanza `EXPORT_FAILED` (`apps/photoshop-uxp/index.js:161-179`). No hay duplicado de documento, aislamiento de capa/grupo, export PNG/PSD, lectura de fichero ni encoder que origine esos bytes.
- Los tests de `bridge-photoshop` solo prueban transporte, mutación y builders (`packages/bridge-photoshop/src/index.test.ts:8-81`); no prueban `executeBatchPlay`, error modal, `exportLayers` ni persistencia.
- El “test” del panel es un validador de manifest/ficheros, no un test funcional (`apps/photoshop-uxp/scripts/validate.mjs:1-10`).

**Conclusión B4:** `batchPlay` queda razonablemente remediado a nivel de código; `exportLayers` no es funcional con un host real y B4 no está cerrado.

### B5 — MCP Resources y presets After Effects

**Correcciones verificadas**

- El Gateway anuncia `resources` en `initialize` y atiende `resources/list` y `resources/read` (`apps/gateway/src/index.ts:72-80`).
- Existe una prueba MCP de listado y lectura (`apps/gateway/src/index.test.ts:5`).
- El catálogo usa SHA-256 real para fingerprints (`packages/bridge-aftereffects/src/presets.ts:15,30`).
- El JSX incorpora `bridge.preset.apply`, undo group y recetas para efectos/animación/cámara/tracking (`apps/aftereffects-panel/src/AfterEffectsBridge.jsx:37-48,160-172`).

**Bloqueos**

- La ruta daemon → JSX no adjunta el preset, según lo descrito en B1. El test del bridge sí pasa porque prueba directamente `AfterEffectsBridge.applyPreset()`, que usa el helper inyector; no prueba el camino real del daemon.
- El preset `motion.motion-blur` declara categoría `animation` con `{enabled:true}`, pero la rama de animación exige `recipe.expression`; la comprobación especial de motion blur se encuentra dentro de esa rama y resulta inalcanzable para ese preset (`AfterEffectsBridge.jsx:42`).
- `resources/list/read` se procesan antes del bloque `try` de `GatewayServer.handle`; una URI inexistente puede escapar como excepción en vez de producir un error JSON-RPC normalizado (`apps/gateway/src/index.ts:76-80`).
- El catálogo está duplicado entre Gateway y bridge, sin fuente única ni prueba de igualdad.

**Conclusión B5:** recursos MCP cerrados en happy path; aplicación productiva de presets no cerrada.

### B6 — `aerender`, render farm y SHA-256

**Correcciones verificadas**

- `buildAerenderArgs()` emite `-RStemplate` y `-OMtemplate` (`packages/bridge-aftereffects/src/aerender.ts:129-139`).
- `spawn` usa argumentos separados, `shell:false` y `windowsHide:true` (`aerender.ts:167-178`).
- `renderFarm()` clona el proyecto, segmenta, ejecuta segmentos, crea un output y calcula SHA-256 (`aerender.ts:65-91`).
- `AfterEffectsBridge.exportWithAerender()` invoca `renderFarm` cuando detecta `segmentSize` y publica hash/tamaño (`packages/bridge-aftereffects/src/index.ts:233-247`).

**Bloqueos**

1. La herramienta `adobe.aftereffects.render` expone `mode`, `compId`, `range`, templates y destination (`packages/tool-catalog/src/index.ts:81`). El daemon coloca todo ello en `ExportRequest.options`. El bridge, sin embargo, exige `options.request` con un `AerenderRequest` (`packages/bridge-aftereffects/src/index.ts:233-238`), campo que el esquema estricto no permite. La ruta `mode: "aerender"` falla antes de lanzar el proceso.
2. `renderFarm` lee los ficheros de segmentos y escribe `Buffer.concat(chunks)` (`aerender.ts:86-90`). Concatenar binariamente MOV/MP4 u otros contenedores no crea un vídeo válido; tampoco se define una semántica correcta de secuencia de imágenes/manifiesto.
3. `AerenderWorker.run()` marca éxito por exit code sin verificar en ese nivel que el output exista (`aerender.ts:200-206`). La verificación posterior no corrige la falta de un ensamblado válido.
4. No hay prueba de `-RStemplate`, `renderFarm`, creación/validación de outputs segmentados, SHA-256 final ni ruta MCP. Los tests solo cubren argv sin templates, parser de progreso, proceso simulado y matemática de segmentación (`packages/bridge-aftereffects/src/index.test.ts:117-154`).

**Conclusión B6:** varias piezas están corregidas, pero la ruta productiva y el ensamblado siguen siendo bloqueantes.

### B7 — Illustrator

**Correcciones verificadas**

- `IllustratorEditCommand` ya incluye `create-path`, `compound-path`, `boolean` y `set-typography` (`packages/schemas/src/index.ts:48-57`), por lo que el bridge los acepta mediante la validación de `packages/bridge-illustrator/src/index.ts:176-193`.
- El panel anuncia capacidades y permite esos comandos (`apps/illustrator-uxp/index.js:6-12`).
- Existe export multi-artboard con escala/maxDimension y retorno de bytes (`index.js:78`), y el daemon/bridge generan hashes y artefactos.

**Bloqueos**

- `compound-path` no crea un compound path: crea un `groupItem` y mueve los elementos dentro (`apps/illustrator-uxp/index.js:76`).
- El pathfinder también crea primero un grupo. Para `union` usa el comando `group`, no una operación de unión; para las otras variantes no selecciona explícitamente los operandos ni expande/verifica el resultado. El receipt puede informar éxito aunque no exista el resultado geométrico solicitado.
- `set-typography` no aplica `kerning`; la alineación se asigna directamente desde strings contractuales sin adaptación a constantes/enums host (`index.js:76`).
- `exportArtboards` solo exige que haya algún output; no comprueba que todos los IDs pedidos se hayan encontrado. No hay validación de las dimensiones codificadas del PNG/SVG.
- La prueba vectorial solo verifica el objeto del builder y la fórmula de downscaling (`packages/bridge-illustrator/src/index.test.ts:89-93`). No ejecuta el panel, no prueba pathfinders/tipografía ni export multi-artboard.
- El paquete UXP usa `node --check index.js` como test y typecheck.

**Conclusión B7:** integración estructural parcial; semántica host y cobertura insuficientes para certificar.

### B8 — Determinismo de metadatos

**Conforme.**

- En un `put` duplicado, `ArtifactStore` lee y devuelve el metadata persistido en lugar del metadata recién generado (`packages/artifact-store/src/index.ts:19-35`).
- Verifica digest, URI y tamaño antes de devolverlo (`index.ts:31-33`).
- La prueba usa mismos bytes con media type/provenance conflictivos y exige igualdad exacta con la primera escritura (`packages/artifact-store/src/index.test.ts:16-23`).

Riesgo residual no bloqueante para B8: no hay limpieza/rollback transaccional si una escritura falla permanentemente entre blob y metadata, aunque una llamada posterior puede completar el metadata.

### B9 — Aislamiento de saga y errores de compensación

**Conforme en el alcance solicitado.**

- Ejecución y lookup usan `${transactionId}:${step.idempotencyKey}` (`packages/workflow-engine/src/saga.ts:20-24`).
- Compensación usa el mismo scope y una clave propia `${transactionId}:compensate:${step.id}` (`saga.ts:30-34`).
- Los fallos se conservan en `compensationErrors` y se incorporan al resultado del paso (`saga.ts:29-36`).
- La prueba ejecuta dos transacciones con claves de paso iguales y comprueba scope y errores de compensación (`packages/workflow-engine/src/index.test.ts:6-11`).

Riesgos residuales: `SagaTransactionLog` sigue en memoria y la prueba no comprueba el contenido exacto de cada error, persistencia tras reinicio ni reintentos de compensación. No invalidan las dos correcciones concretas pedidas en B9, pero impiden considerar el motor durable.

## 4. Verificaciones ejecutadas

| Comando | Resultado | Evidencia |
|---|---:|---|
| `pnpm turbo run test typecheck --force` | **PASS, exit 0** | Turbo 2.11.6: **54/54 tareas**, **0 cacheadas**, 14.101 s. Premiere bridge 10 tests; AE 9; Illustrator 6; Photoshop 3; daemon 4; Premiere UXP 2. |
| `pnpm test:contract` | **PASS, exit 0** | **22/22 tareas**, **21 cacheadas**, 1 ejecutada, 1.383 s. Reproduce mayoritariamente resultados de caché. |
| `pnpm schemas:check` | **PASS, exit 0** | `node dist/generate.js --check`; sin diferencias, 0.729 s aprox. |

### Interpretación de los verdes

- `apps/aftereffects-panel` define `test` como `node -e "process.exit(0)"`.
- `apps/illustrator-uxp` usa `node --check index.js` para test y typecheck.
- `apps/photoshop-uxp` valida manifest y presencia de ficheros, no comportamiento host.
- No se ejecutó Photoshop, Illustrator, After Effects ni Premiere real.
- Los contratos y typechecks son consistentes, pero faltan pruebas E2E de las rutas especializadas y de outputs Adobe reales.

## 5. Condiciones mínimas para recertificación

1. Extender el input de `adobe.premiere.editPlan.execute` con `plan`/`approval` o adaptar la política R3 de forma tipada; añadir prueba gateway → daemon → panel para una ejecución aprobada y otra rechazada.
2. Hacer que el daemon resuelva e inyecte el preset canónico antes de `bridge.preset.apply`, o que el panel resuelva `presetId` desde un catálogo versionado común; probar todos los presets, incluido motion blur.
3. Implementar un adapter Premiere UXP concreto para transform/crop, transición, delete no-ripple y resto de EditPlan; probarlo contra un harness fiel o host Adobe compatible.
4. Implementar export de capas real en Photoshop (aislamiento, export/encode, lectura y limpieza), persistir mediante el ArtifactStore canónico y probar bytes/hash/procedencia y fallos `batchPlay`.
5. Alinear el contrato `adobe.aftereffects.render` con `AerenderRequest`, resolver grants a rutas, sustituir concatenación binaria por ensamblado válido o manifiesto de secuencia y probar `renderFarm`/SHA-256.
6. Implementar compound paths y pathfinders nativos verificables en Illustrator, mapear tipografía completa, exigir todos los artboards y validar dimensiones/bytes exportados.
7. Sustituir los tests vacíos/sintácticos de panel por suites funcionales y añadir una matriz E2E para las cuatro herramientas especializadas.

## 6. Decisión formal

- **B8:** certificado.
- **B9:** certificado para aislamiento de clave y tracking de errores de compensación.
- **B3:** corregido en el motor puro, no certificado E2E.
- **B1, B2, B4, B5, B6 y B7:** no certificados.

Por tanto, aunque la remediación mejora materialmente el repositorio y todas las verificaciones automatizadas solicitadas están verdes, **no existe evidencia suficiente ni una ruta ejecutable completa para certificar B1–B9 como resueltos**. El resultado final es **NO CERTIFICADO**, con B8 y B9 aceptados y el resto pendiente de los cierres indicados.

## 7. Nota de trazabilidad

El directorio suministrado no está reconocido por Git como worktree (`git status` devuelve “not a git repository”), por lo que no fue posible asociar el dictamen a un commit ni comprobar cambios previos mediante diff. La evaluación corresponde exactamente al contenido disponible en `D:\mcp\adobe-mcp` durante esta ejecución.
