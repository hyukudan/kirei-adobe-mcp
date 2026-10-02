# Veredicto final de certificación — cuatro puntos finales

**Proyecto:** `adobe-mcp`  
**Fecha de revisión final:** 2026-10-02  
**Documento de contraste:** `FINAL_CERTIFICATION.md`  
**Alcance de esta revisión:** resolución de los dos bloqueos finales de After Effects y Premiere Pro sobre el estado actual del código y de las pruebas.

## Dictamen

**RESULTADO: CERTIFICADO.**

Los dos puntos que permanecían abiertos han quedado resueltos y cuentan con pruebas automatizadas satisfactorias. En consecuencia, junto con los puntos 1 (comparación RGBA) y 4 (`adobe.system.status`) ya conformes en la auditoría anterior, los cuatro puntos finales quedan certificados.

| Punto final revisado | Estado | Conclusión |
|---|---|---|
| After Effects: handshake y framing TCP | **Conforme** | Node y JSX usan el mismo payload de `bridge.auth`: `{ sessionId, proof, clientNonce, serverNonce }`. La prueba TCP valida los cuatro valores, exige autenticación antes del comando y comprueba frames JSON delimitados por salto de línea, incluida una respuesta fragmentada. |
| Premiere Pro: PNG real y downscaling | **Conforme** | `encodePngBase64` genera PNG RGBA válido con `IHDR`, `IDAT` comprimido, CRC e `IEND`. La prueba genera bytes 100x50 a partir de una fuente lógica 200x100, confirma sus dimensiones mediante `decodeImageDimensions` y rechaza bytes reales 200x100 cuando `maxDimension` es 100. |

## 1. After Effects: alineación de `bridge.auth`

**Estado: CONFORME.**

La implementación Node de `TcpAfterEffectsPanelTransport`:

- obtiene `sessionId` y `serverNonce` del `bridge.hello`;
- calcula `proof` con `clientNonce`, `serverNonce` y `sessionId`;
- envía en `bridge.auth` los cuatro campos requeridos: `sessionId`, `proof`, `clientNonce` y `serverNonce` (`packages/bridge-aftereffects/src/index.ts:63-65`).

La implementación ExtendScript exige el mismo contrato (`apps/aftereffects-panel/src/AfterEffectsBridge.jsx:149-150`):

- requiere que los cuatro campos sean cadenas no vacías;
- contrasta `sessionId` y `serverNonce` con el challenge activo;
- rechaza la reutilización de `clientNonce`;
- recalcula el HMAC incluyendo ambos nonces y la sesión, y compara el resultado antes de marcar la conexión como autenticada.

El framing también coincide:

- Node escribe cada solicitud como un único JSON seguido de `\n` (`packages/bridge-aftereffects/src/index.ts:69-77`) y conserva en un acumulador cualquier frame incompleto (`:102-107`).
- JSX escribe `JSON + "\n"` en TCP (`apps/aftereffects-panel/src/AfterEffectsBridge.jsx:13`) y `poll` acumula lecturas, separa por `/\r?\n/` y conserva el fragmento final (`:191`).

La prueba TCP real de `packages/bridge-aftereffects/src/index.test.ts:62-109` levanta un servidor loopback y acredita que:

1. `bridge.hello` lleva el `clientNonce` esperado.
2. `bridge.auth` contiene exactamente los valores esperados de `sessionId`, `proof`, `clientNonce` y `serverNonce`.
3. El proof coincide con `computeAuthProof` para esos valores.
4. El comando `ae.preview.capture` solo se considera ejecutado después de autenticar.
5. Las tres solicitudes llegan como tres frames delimitados.
6. Una respuesta de `bridge.hello` partida en dos escrituras se recompone correctamente; además, una respuesta de comando de más de 20 KB atraviesa el framing sin truncarse.

Esta prueba ejecuta el transporte Node contra un peer TCP controlado; la conformidad del lado JSX se acredita mediante la inspección directa de su contrato y acumulador, no mediante la ejecución de ExtendScript fuera del host Adobe.

## 2. Premiere Pro: `encodePngBase64` y validación de downscaling

**Estado: CONFORME.**

`packages/bridge-core/src/testkit.ts:13-38` implementa un encoder PNG de prueba real:

- valida dimensiones y la cantidad/rango de los píxeles RGBA;
- escribe la firma PNG;
- crea `IHDR` con ancho, alto, profundidad de 8 bits y color RGBA;
- construye scanlines con filtro 0 y las comprime con `deflateSync` dentro de `IDAT`;
- calcula CRC-32 para cada chunk;
- finaliza con `IEND` y devuelve Base64.

`packages/bridge-premiere/src/index.test.ts:59-80` parte de una fuente de 200x100 y un `maxDimension` de 100. El caso verifica:

- cálculo proporcional a 100x50, con escala 0,5;
- solicitud de exportación con ancho 100 y alto 50;
- generación de bytes PNG reales de 100x50;
- decodificación independiente mediante `decodeImageDimensions`, cuyo resultado debe ser `{ format: "png", width: 100, height: 50 }`;
- coherencia de las dimensiones publicadas por `capturePreview`.

El caso negativo de `packages/bridge-premiere/src/index.test.ts:82-92` genera bytes PNG reales de 200x100 y confirma que `PremiereBridge.capturePreview` los rechaza cuando `maxDimension` es 100. La protección se basa en las dimensiones decodificadas del archivo (`packages/bridge-premiere/src/index.ts:172-177`), no únicamente en los metadatos declarados por el host.

## Evidencia automatizada ejecutada

Ejecutado el 2026-10-02 sobre el estado revisado:

- `pnpm --filter @adobe-mcp/bridge-aftereffects test`: **7/7 tests correctos**.
- `pnpm --filter @adobe-mcp/bridge-premiere test`: **6/6 tests correctos**.
- `pnpm --filter @adobe-mcp/bridge-core test`: **6/6 tests correctos**.

Todas las órdenes terminaron con código de salida 0.

## Decisión final

Quedan cerrados los dos bloqueos finales:

1. El handshake TCP de After Effects está alineado en Node y JSX, y su prueba valida íntegramente nonces, proof, orden de autenticación y framing de comandos.
2. Premiere dispone de un PNG de prueba estructuralmente real y demuestra tanto el resultado 200x100 → 100x50 mediante decodificación de bytes como el rechazo de una imagen cuyos bytes exceden el límite.

**La resolución completa de los cuatro puntos finales queda certificada.**
