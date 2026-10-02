# Propuesta de Evolución y Nuevas Capacidades: adobe-mcp (Claude Opus)

**Fecha:** 2026-10-02  
**Autor:** Claude Opus (Análisis y Diseño Estratégico)  
**Objetivo:** Sintetizar las mejores capacidades de los repositorios de la comunidad (`photoshop-mcp`, `premiere-mcp`, `ae-mcp`, `ae-mcp-imt`) en nuestra arquitectura tipada, segura y orquestada.

---

## 1. Resumen Ejecutivo y Diagnóstico Comparativo

### 1.1 Nuestra Fortaleza vs Repositorios Comunitarios
- **Nuestras Fortalezas**:
  - **Seguridad y Contratos**: Modelo de riesgo R0–R4, tokens criptográficos ligados al plan, autenticación HMAC loopback, ejecución de `aerender` sin shell y gestión de snapshots con rollback declarativo.
  - **Arquitectura Monorepo**: Tipado TypeScript 100% estricto, esquemas deterministas Zod/Draft 2020-12 y `OperationStore` idempotente.
- **Fortalezas de la Comunidad a Sintetizar**:
  - **Profundidad de Operaciones Host**: Los repositorios comunitarios cuentan con 126–283 operaciones probadas directamente en hosts de Adobe (Photoshop 27, Premiere 26, After Effects 26).
  - **Primitivas de Inspección Visual (Vision Preview)**: Renderizado inmediato de fotogramas para que el agente de IA vea el resultado antes de confirmar mutaciones.
  - **Automatizaciones de Alto Nivel**: Detección de silencios en Premiere, transcripciones sincronizadas, plantillas data-driven y exportación multicapa estructurada.

---

## 2. Nuevas Capacidades Recomendadas por Aplicación

### 2.1 Visión y Verificación en Fotograma (`adobe.preview.capture` y `adobe.verify.visual`)
- **Photoshop**: Captura instantánea de viewport/documento con `photoshop.imaging.getPixels` o renderizado rápido a PNG en memoria.
- **After Effects**: Frame snapshot mediante `CompItem.saveFrameToPng(time, file)` y comparación diferencial antes/después con `verification: "render-proof"`.
- **Premiere Pro**: `Sequence.exportFramePNG(time, file)` o acceso directo a frames de preview en timeline para validar cortes y encuadres.
- **Illustrator**: Exportación SVG/PNG de baja resolución ultrarrápida para auto-evaluación compositiva del agente.

### 2.2 Photoshop Avanzado
- **Constructores Declarativos de `batchPlay`**: Reemplazar descriptores libres por builders tipados para transformaciones complejas, máscaras de capa avanzadas, filtros neuronales/Camera Raw y capas de ajuste no destructivas.
- **Exportación de Assets por Capa / Slice**: Pipeline de exportación automática de todos los grupos/capas con hash SHA-256 de procedencia para importación directa en After Effects o Premiere.

### 2.3 After Effects & Motion Graphics
- **Catálogo de Presets de Efectos Declarativos**: MatchNames estandarizados y recetas de animación (wiggles, cámaras 3D, transiciones, motion blur, tracking) publicados como recursos MCP (`resources/list`).
- **Renderizado por Lotes con `aerender` Inteligente**: Copia temporal de proyecto, segmentación por rangos de frames (render farm local) y verificación de hash del archivo de salida final.

### 2.4 Premiere Pro: Edición Inteligente Declarativa
- **`EditPlan` Declarativo**: Edición basada en intenciones (ej. `cut-silences`, `auto-ducking` de música ante locución, reencuadre automático para formato vertical 9:16 / Reels / TikTok).
- **Control de Secuencias Completo**: Gestión nativa de transiciones de vídeo/audio, pistas de subtítulos (captions) y sincronización multicámara.

---

## 3. Hoja de Ruta de Implementación (Luna High ➔ Sol Medium)

| Fase | Alcance | Rol de Luna High | Rol de Sol Medium |
| :--- | :--- | :--- | :--- |
| **F0 (Núcleo MCP)** | Envelopes MCP nativos con `content: [{type: "text"}, {type: "image"}]`, IDs estables por UUID persistente en UXP y resolución de warnings de auditoría. | Implementar adaptadores en `gateway` y `daemon`. | Auditar conformidad estricta del protocolo MCP. |
| **F1 (Vision & Preview)** | Herramienta universal `adobe.preview.capture` en los 4 hosts con codificación Base64 PNG y `adobe.verify.visual`. | Programar handlers en UXP y ExtendScript. | Probar fidelidad visual y tiempo de respuesta p95. |
| **F2 (Profundidad Premiere & PS)** | Implementar DOM nativo completo de Premiere (cortes, transiciones, audio tracks) y builders `batchPlay` seguros en Photoshop. | Escribir paneles y scripts CEP/UXP. | Auditar prevención de inyecciones y control transaccional. |
| **F3 (Presets & Artifacts)** | Recursos MCP con recetas de efectos AE, LUTs y almacén de artefactos con procedencia content-addressed. | Desarrollar `packages/artifact-store` y `packages/presets`. | Validar inmutabilidad y firmas de procedencia. |
| **F4 (Workflows Multi-App)** | Sagas cross-app (Photoshop export ➔ Illustrator comp ➔ AE motion ➔ Premiere timeline assembly) con compensación completa. | Ensamblar DAGs en `workflow-engine`. | Ejecutar pruebas E2E del flujo cruzado completo. |
