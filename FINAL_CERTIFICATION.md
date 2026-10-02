# Informe final de certificación de la remediación B1–B5

**Proyecto:** `adobe-mcp`  
**Fecha:** 2026-10-02  
**Base de contraste:** `AUDIT_REPORT_F0_F1.md`, `OPUS_FEATURE_PROPOSAL.md` y código fuente actual  
**Alcance solicitado:** B4, B1, B3, B5/A1 y A2

## Dictamen

**Resultado: NO CERTIFICADO.**

La remediación cierra satisfactoriamente B4 y el subalcance solicitado de B5/A1. B1 está corregido en el framing de mensajes, pero no queda cerrado de extremo a extremo porque el transporte TCP ExtendScript no está integrado con un listener compatible en el daemon. B3 mejora de forma material en Illustrator y After Effects, incluida la limpieza en `finally`, pero Premiere sigue siendo una abstracción sin host ejecutable ni prueba de que el fichero exportado respete las dimensiones solicitadas. A2 está registrado a lo largo de la pila, pero su algoritmo compara bytes de ficheros comprimidos, no píxeles; por tanto no implementa una verificación visual fiable.

Los bloqueos restantes son funcionales y semánticos, no de compilación.

## Evidencia automatizada ejecutada

- `pnpm turbo run test typecheck --force`: **50/50 tareas correctas**, sin caché.
- `pnpm schemas:check`: **correcto**.
- Gateway: pasa el test de orden `image` → `text` y ausencia del Base64 en el texto.
- Daemon: pasa la prueba de preservación del `sessionId` autenticado y filtrado positivo por `target`.

Limitaciones de esa evidencia:

- `apps/aftereffects-panel` declara como test `node -e "process.exit(0)"`; no prueba framing, autenticación, captura, escalado ni limpieza.
- `apps/premiere-uxp` usa TypeScript `--noEmit` como test; no prueba un host Premiere real.
- `apps/illustrator-uxp` solo ejecuta `node --check`.
- No hay prueba host/E2E que decodifique las imágenes, contraste dimensiones reales, MIME y magic bytes, verifique residuos temporales o mida p95.

## Matriz de certificación

| Requisito | Estado | Resultado |
|---|---:|---|
| B4 — respuesta MCP visual | **Conforme** | Imagen primero, texto después y Base64 eliminado del JSON textual. |
| B1 — framing AE por salto de línea | **Parcial** | El framing JSON-lines está implementado, pero no existe una ruta TCP completa y ejecutable daemon ↔ ExtendScript. |
| B3 — downscaling y temporales | **Parcial** | Illustrator y AE hacen escalado real en código y limpian en `finally`; Premiere no demuestra escalado real ni integración host. |
| B5/A1 — `sessionId`, `target`, `includeBridges` | **Conforme con cobertura incompleta** | La lógica es correcta; falta test explícito de `includeBridges:false` y escenarios multi-sesión/reconexión. |
| A2 — `adobe.verify.visual` | **No conforme semánticamente** | La herramienta existe en toda la pila, pero el `diffScore` se calcula sobre bytes comprimidos, no sobre contenido visual. |
| B5 original — IDs persistentes | **No cerrado** | La remediación revisada no aporta la suite ni las garantías de UUID persistente exigidas por el informe base. |

## 1. B4 — formato de `tools/call`

**Estado: CONFORME para el requisito solicitado.**

En `apps/gateway/src/index.ts:17-27`, `mcpToolResult`:

1. Detecta `imageBase64` y también `currentImageBase64`.
2. Construye primero `{ type: "image", data, mimeType }`.
3. Construye después `{ type: "text", text }`.
4. Elimina ambos campos Base64 del objeto `data` antes de ejecutar `JSON.stringify`.
5. Mantiene el envelope `{ok:true,data}` en el bloque textual.

La prueba `apps/gateway/src/index.test.ts:4` comprueba el orden exacto, el MIME, los datos de imagen y que el texto no contenga el Base64. La ruta de error sigue produciendo solo texto con `isError:true`.

Observación menor: el test visual solo cubre `imageBase64`, no `currentImageBase64`, y no prueba explícitamente el caso de error. Esto no invalida la lógica inspeccionada, pero conviene completar la regresión.

## 2. B1 — framing RPC de After Effects

**Estado: PARCIAL; no certificable de extremo a extremo.**

La corrección de framing sí está presente en `apps/aftereffects-panel/src/AfterEffectsBridge.jsx`:

- `send` añade `"\n"` a cada mensaje escrito por `Socket` (`:13`).
- `poll` acumula lecturas parciales en `readBuffer`, separa por `/\r?\n/` y conserva el fragmento incompleto (`:191`).
- `receiveLine` desempaqueta `{type:"rpc", request:{...}}` antes de despachar (`:181-189`).
- `reply` devuelve el mismo envelope `type: "rpc"` exigido por el daemon (`:14`).
- `saveFrameToPng` recibe objetos `File`, no `fsName` (`:115` y `:122`).

También existe un transporte Node JSON-lines en `packages/bridge-aftereffects/src/index.ts:48-120`, que escribe una nueva línea por solicitud y consume respuestas delimitadas por `\n`.

No obstante, las dos piezas no forman una conexión ejecutable:

- `AfterEffectsBridgePanel.connectTcp` abre un `Socket` saliente hacia `host:port` (`AfterEffectsBridge.jsx:192`).
- `TcpAfterEffectsPanelTransport` también abre una conexión TCP saliente mediante `createConnection` (`packages/bridge-aftereffects/src/index.ts:90-99`).
- El daemon solo crea un servidor HTTP/WebSocket (`apps/daemon/src/index.ts:1,6,66`); no crea un servidor TCP JSON-lines.
- ExtendScript `Socket` no realiza el handshake WebSocket, por lo que apuntarlo al puerto WebSocket del daemon no convierte esta ruta en compatible.

Por tanto, el defecto concreto de delimitación y envelope está corregido, pero la condición original de cierre —autenticar, capturar y mantener viva una sesión real— no está demostrada y la topología TCP actual carece de listener. Se requiere decidir una arquitectura única: listener TCP loopback en el daemon para ExtendScript, o servidor TCP en el panel con el transporte Node como cliente; después debe añadirse una prueba de integración real.

## 3. B3 — downscaling proporcional y limpieza

**Estado: PARCIAL.**

### Illustrator

`apps/illustrator-uxp/index.js:79` calcula `scale = min(1, maxDimension / max(width,height))`, conserva la proporción y pasa `horizontalScale` y `verticalScale` al exportador. El archivo temporal se crea con nombre aleatorio y se elimina dentro de `finally`, incluso si exportar o leer falla.

La implementación es plausible, pero no existe test host que decodifique el PNG/JPEG y confirme que sus dimensiones coinciden con `width` y `height`.

### After Effects

`apps/aftereffects-panel/src/AfterEffectsBridge.jsx:109-134` guarda el frame fuente y, cuando `scale < 1`, lo importa en una composición temporal con dimensiones reducidas, ajusta la escala de la capa y exporta un segundo PNG. El `finally` intenta cerrar el fichero abierto y eliminar output, fuente, composición temporal e importación.

Esto constituye downscaling real en el código. Falta una prueba en After Effects que valide dimensiones, pixel aspect, frame solicitado y ausencia de residuos cuando falla cada etapa.

### Premiere Pro

`apps/premiere-uxp/src/index.ts:56-67` calcula dimensiones proporcionales y elimina el temporal en `finally`. Sin embargo:

- El handler llama `exportFramePNG(time, file, {width,height})`, una firma definida por la propia interfaz local (`:51`), sin adaptación concreta ni evidencia host de que Premiere acepte o aplique ese tercer argumento.
- `PremiereTimelinePreviewHandler` no se instancia en el repositorio.
- `UxpPremiereHost.capturePreview` continúa siendo opcional y el entrypoint exige inyección externa del host.
- No hay bootstrap que obtenga la secuencia activa y conecte el handler al panel.

No puede afirmarse que Premiere produzca bytes reducidos; podría exportar a resolución completa mientras reporta metadatos reducidos. En consecuencia, B3 no se cierra para los cuatro hosts.

## 4. B5/A1 — sesión autenticada y filtros de estado

**Estado: CONFORME en la lógica solicitada; cobertura incompleta.**

El daemon crea el `sessionId` durante el challenge y lo asocia al mismo socket mediante `PanelBridge.bindSession` (`apps/daemon/src/index.ts:16-20,108`). Al crear `PanelBridge`, el constructor recupera ese valor del `WeakMap`; `connectedSessions` y `adobe.system.status` publican ese mismo identificador (`packages/bridge-core/src/index.ts:42-45`, `apps/daemon/src/index.ts:80`).

La prueba `apps/daemon/src/index.test.ts:28-35` confirma que el identificador publicado coincide con el del challenge autenticado y que un `target` con `app` e `instanceId` filtra la lista.

El handler además:

- filtra por `target.app`;
- filtra opcionalmente por `target.instanceId`;
- devuelve `bridges: []` cuando `includeBridges === false`;
- calcula el estado usando las sesiones filtradas antes de ocultar el detalle.

La protección de cierre de conexiones antiguas también mejoró: el callback solo desregistra si el objeto `panel` que cierra sigue siendo el registrado (`apps/daemon/src/index.ts:111`). Esto evita que una conexión antigua borre una reconexión más nueva con el mismo `instanceId`.

Faltan pruebas explícitas para `includeBridges:false`, filtro sin coincidencias, varias apps, varias instancias y reconexión con el mismo `instanceId`. La implementación inspeccionada satisface el requisito, pero esas regresiones deberían añadirse.

### Alcance B5 original

El B5 del informe base trataba también la estabilidad e inmutabilidad de IDs de documentos y entidades. Ese hallazgo no queda cerrado por la preservación de `sessionId`:

- Photoshop continúa usando IDs nativos y un `instanceId` derivado de la versión.
- Illustrator conserva el fallback que escribe un marcador en `object.note`.
- After Effects identifica el proyecto por ruta y usa `project-unsaved` para proyectos no guardados.
- Premiere sigue sin host concreto de identidad.

No existe la suite exigida de rename/reorder/reconnect/save/reopen/Save As/duplicate/import. Por ello no se certifica el B5 original completo.

## 5. A2 — `adobe.verify.visual`

**Estado: NO CONFORME como verificación visual completa.**

La incorporación estructural está realizada:

- Schemas: `VisualVerifyInput`, `VisualVerifyData` y `VisualVerifyOutput` en `packages/schemas/src/index.ts:22-24`, incluidos en el manifest generado.
- Catálogo: `adobe.verify.visual` en `packages/tool-catalog/src/index.ts:51`, R0 y con capabilities `state.read@1` y `preview.capture@1`.
- Daemon: handler en `apps/daemon/src/index.ts:82`; el despacho valida input/output y exige capabilities (`:116-160`).
- Bridges: `verifyVisual` existe en core y en los adaptadores Photoshop, Illustrator, After Effects y Premiere; todos capturan una imagen actual y llaman a `compareBase64Images`.
- Resultado: se devuelven `match` y `diffScore` dentro de los límites del schema.

El problema bloqueante está en `packages/bridge-core/src/index.ts:16-23`: la función decodifica Base64 y suma diferencias byte a byte sobre los ficheros PNG/JPEG comprimidos. Eso no equivale a comparar imágenes:

- dos PNG visualmente idénticos pueden diferir por metadatos, filtros, nivel de compresión u orden de chunks y producir un `diffScore` no nulo;
- no se decodifican píxeles ni se normalizan dimensiones, canales, alpha o espacio de color;
- entradas que no sean imágenes válidas pueden llegar al comparador porque `Buffer.from(..., "base64")` no valida magic bytes ni estructura de imagen;
- el denominador usa la longitud máxima en bytes comprimidos, por lo que el score depende del encoder y del tamaño del fichero, no del número de píxeles;
- no hay tests unitarios del comparador ni tests de equivalencia visual entre codificaciones distintas.

Así, A2 está conectado de schema a bridge, pero `match` no representa de forma fiable una coincidencia visual. Para certificarlo se debe decodificar baseline y captura, normalizar ambas a un formato de píxel definido, comprobar dimensiones o aplicar una política explícita de resize, calcular una métrica documentada por píxel y probar casos idénticos, distintos, alpha, dimensiones incompatibles, Base64 inválido y PNG/JPEG con codificaciones diferentes.

## Condiciones mínimas para certificación

1. Proveer una ruta TCP After Effects completa con exactamente un listener, autenticación y JSON-lines, y un test E2E que capture y mantenga viva la sesión.
2. Integrar un host Premiere ejecutable y demostrar mediante decodificación que `maxDimension` limita los bytes exportados.
3. Añadir pruebas host de dimensiones reales y limpieza en éxito y error para Illustrator, After Effects y Premiere.
4. Reemplazar la comparación de bytes comprimidos por una comparación de píxeles validada y añadir pruebas de `adobe.verify.visual` a través del daemon y Gateway.
5. Completar los tests de `adobe.system.status` para `includeBridges:false`, multi-sesión y reconexión.
6. Si el alcance incluye el B5 original, implementar y probar la estrategia de IDs persistentes en los cuatro hosts.

## Decisión final por fase

**F0: no certificada.** B4 y la correlación de sesión están corregidos, pero las garantías de IDs persistentes del B5 original siguen pendientes.

**F1: no certificada.** El pipeline de preview ha mejorado, pero After Effects no tiene transporte TCP completo, Premiere no tiene integración host ejecutable y `adobe.verify.visual` no realiza todavía una comparación visual semántica.

La compilación y los tests existentes son satisfactorios, pero no compensan estos bloqueos de producción.
