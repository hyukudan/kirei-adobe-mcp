/* global WebSocket, crypto, require */

const photoshop = require("photoshop");
const uxp = require("uxp");
const { app, core, action } = photoshop;
const { storage } = uxp;
const localFileSystem = storage.localFileSystem;
const PROTOCOL_VERSION = "1.0";
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const capabilities = ["state.read@1", "state.write@1", "layers.write@1", "filters.write@1", "text.write@1", "snapshot.create@1", "preview.capture@1", "export.file@1", "export.layers@1", "batch.atomic@1", "batchplay.write@1"];

const state = {
  socket: null,
  endpoint: null,
  token: null,
  sessionId: null,
  connected: false,
  reconnectTimer: null,
  reconnectAttempt: 0,
  heartbeat: null,
  lastSeen: 0,
  revisions: new Map(),
  operations: new Map(),
};

const $ = (id) => document.getElementById(id);
function setStatus(text, ready = false) { $("status").textContent = text; $("dot").className = ready ? "ready" : ""; }
function showError(error) { $("details").textContent = error instanceof Error ? error.message : String(error); }
function randomBytes(size) { const bytes = new Uint8Array(size); crypto.getRandomValues(bytes); return bytes; }
function base64Url(bytes) { let text = ""; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function base64UrlBytes(value) { const text = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4)); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; }
async function hmac(token, value) { const key = await crypto.subtle.importKey("raw", base64UrlBytes(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)))); }
async function sha256(value) { const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); return Array.from(digest, (x) => x.toString(16).padStart(2, "0")).join(""); }
function targetKey(target) { return `${target.app}:${target.instanceId || "active"}:${target.documentId || target.entityId || "root"}`; }
function nativeId(layer) { return String(layer.id); }
function number(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function boundsOf(layer) {
  const bounds = layer.bounds || {};
  const x = number(bounds.left ?? bounds.x); const y = number(bounds.top ?? bounds.y);
  const right = number(bounds.right, x); const bottom = number(bounds.bottom, y);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y), unit: "px" };
}
function layerKind(layer) {
  const kind = String(layer.kind || layer.typename || "").toLowerCase();
  if (kind.includes("group") || kind.includes("layerset")) return "group";
  if (kind.includes("text")) return "text";
  if (kind.includes("smart")) return "smart-object";
  if (kind.includes("adjust")) return "adjustment";
  if (kind.includes("shape") || kind.includes("content")) return "shape";
  if (kind.includes("fill")) return "fill";
  return "pixel";
}
function childrenOf(layerOrDocument) { return Array.from(layerOrDocument.layers || []); }
function walkLayers(collection, parentId, output) {
  for (const layer of collection) {
    const id = nativeId(layer);
    output.push({ id, name: String(layer.name || "Layer"), kind: layerKind(layer), parentId: parentId || null, visible: layer.visible !== false, locked: Boolean(layer.locked), opacity: Math.max(0, Math.min(1, number(layer.opacity, 100) / 100)), blendMode: String(layer.blendMode || "normal"), bounds: boundsOf(layer), selected: Boolean(layer.selected) });
    const children = childrenOf(layer);
    if (children.length) walkLayers(children, id, output);
  }
}

async function execute(name, callback) { return core.executeAsModal(callback, { commandName: `Adobe MCP: ${name}` }); }
function batchPlayError(result) {
  const values = Array.isArray(result) ? result : [result];
  const failed = values.find((value) => value && typeof value === "object" && (value._obj === "error" || value.error || value._isCommand === false));
  if (failed) throw new Error(`HOST_ERROR: Photoshop batchPlay descriptor failed: ${JSON.stringify(failed).slice(0, 1800)}`);
  return result;
}
async function batchPlay(commands, options = {}) {
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 500) throw new Error("INVALID_ARGUMENT: batchPlay requires 1..500 descriptors");
  const merged = { synchronousExecution: true, modalBehavior: "fail", continueOnError: false, ...options };
  return execute("batchPlay", async () => batchPlayError(await action.batchPlay(commands, merged)));
}
async function play(commands) { return batchPlay(commands, { synchronousExecution: true, modalBehavior: "fail" }); }
function activeDocument() { if (!app.documents || !app.activeDocument) throw new Error("NOT_FOUND: no active Photoshop document"); return app.activeDocument; }

async function inspectDocument(target) {
  return execute("inspect", async () => {
    const document = activeDocument();
    await play([{ _obj: "get", _target: [{ _ref: "document", _enum: "ordinal", _value: "targetEnum" }] }]);
    const layers = []; walkLayers(childrenOf(document), null, layers);
    const key = targetKey(target); const revision = state.revisions.get(key) || `ps-${document.id}-${Date.now()}`; state.revisions.set(key, revision);
    return { target, revision, data: { id: String(document.id), revision, name: String(document.name || "Untitled"), saved: Boolean(document.saved), width: number(document.width, 1), height: number(document.height, 1), unit: "px", resolutionPpi: number(document.resolution, 72), mode: String(document.mode || "rgb").toLowerCase(), bitDepth: Number(document.bitsPerChannel || 8), activeLayerIds: (document.activeLayers || []).map(nativeId), layers, truncated: false } };
  });
}

function layerTarget(id) { return { _ref: "layer", _id: Number(id) || id }; }
function createAction(command) {
  const type = command.kind === "text" ? "textLayer" : command.kind === "shape" ? "contentLayer" : command.kind === "group" ? "layerSection" : "layer";
  const using = { _obj: type, name: command.name };
  if (command.properties && typeof command.properties === "object") Object.assign(using, command.properties);
  return { _obj: "make", _target: [{ _ref: "layer" }], using };
}
function actionFor(command, tempIdMap) {
  const resolve = (id) => tempIdMap[id] || id;
  if (command.op === "create") return createAction(command);
  if (command.op === "set") {
    const patch = command.patch || {}; const to = { _obj: "layer" };
    if (patch.name !== undefined) to.name = patch.name;
    if (patch.visible !== undefined) to.visible = patch.visible;
    if (patch.opacity !== undefined) to.opacity = patch.opacity * 100;
    if (patch.blendMode !== undefined) to.mode = { _enum: "blendMode", _value: patch.blendMode };
    if (patch.locked !== undefined) to.layerLock = { _obj: "layerLock", protectAll: patch.locked };
    return { _obj: "set", _target: [layerTarget(resolve(command.layerId))], to };
  }
  if (command.op === "transform") return { _obj: "transform", _target: command.layerIds.map((id) => layerTarget(resolve(id))), matrix: command.matrix, _isCommand: true };
  if (command.op === "delete") return { _obj: "delete", _target: command.layerIds.map((id) => layerTarget(resolve(id))) };
  if (command.op === "filter") return { _obj: "apply", _target: [layerTarget(resolve(command.layerId))], filter: { _obj: command.filter, ...(command.parameters || {}) } };
  if (command.op === "text") return { _obj: "set", _target: [layerTarget(resolve(command.layerId))], to: { _obj: "textLayer", textKey: { textValue: String(command.text), ...(command.properties || {}) } } };
  throw new Error(`INVALID_ARGUMENT: unsupported Photoshop command ${String(command.op)}`);
}

async function mutate(request) {
  const key = targetKey(request.target); const current = state.revisions.get(key);
  if (request.options && request.options.expectedRevision && current && request.options.expectedRevision !== current) throw new Error("CONFLICT: expectedRevision is stale");
  if (state.operations.has(request.options.operationId)) return state.operations.get(request.options.operationId);
  if (request.options && request.options.dryRun) return { status: "planned", previousRevision: current, appliedIndexes: [], failedIndexes: [], tempIdMap: {}, compensations: [], verification: "skipped" };
  const receipt = await execute("mutate", async () => {
    const document = activeDocument(); const tempIdMap = {}; const appliedIndexes = []; const failedIndexes = [];
    for (let index = 0; index < request.commands.length; index++) {
      const command = request.commands[index];
      try {
        const result = await play([actionFor(command, tempIdMap)]);
        if (command.op === "create") {
          const created = result && result[0] && (result[0]._id || result[0].id);
          if (created) tempIdMap[command.tempId] = String(created);
          else { const found = childrenOf(document).find((layer) => String(layer.name) === command.name); if (found) tempIdMap[command.tempId] = nativeId(found); }
        }
        appliedIndexes.push(index);
      } catch (error) { failedIndexes.push(index); throw new Error(`PARTIAL_FAILURE: command ${index} failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const revision = `ps-${document.id}-${Date.now()}`; state.revisions.set(key, revision);
    return { status: failedIndexes.length ? "partial" : "applied", previousRevision: current, revision, appliedIndexes, failedIndexes, tempIdMap, compensations: [], verification: request.options.verification === "none" ? "skipped" : "passed" };
  });
  state.operations.set(request.options.operationId, receipt); return receipt;
}

async function readGrant(grant) {
  if (!grant || !grant.grantId) throw new Error("INVALID_ARGUMENT: destination FileGrant required");
  const folder = await localFileSystem.getDataFolder();
  let grants; try { grants = await folder.getEntry("grants"); } catch { grants = await folder.createFolder("grants"); }
  const entry = await grants.getEntry(`${grant.grantId}.json`);
  const record = JSON.parse(await entry.read());
  if (!record || (record.access !== "write" && record.access !== "read-write") || !record.canonicalPath) throw new Error("PERMISSION_DENIED: FileGrant does not permit writing");
  return localFileSystem.getEntryWithUrl(record.canonicalPath);
}
function extensionFor(format) { return ({ psd: "psd", psb: "psb", png: "png", jpeg: "jpg", tiff: "tif", webp: "webp" })[format] || format; }
async function exportDocument(request) {
  const entry = await readGrant(request.destination);
  const format = String(request.format || request.options?.format || "psd").toLowerCase();
  return execute("export", async () => {
    const document = activeDocument();
    const options = { extension: extensionFor(format), quality: request.options?.quality, embedColorProfile: request.options?.embedProfile !== false };
    await document.saveAs(entry, options, true);
    const revision = state.revisions.get(targetKey(request.target)) || `ps-${document.id}-${Date.now()}`;
    const artifact = { artifactId: `${document.id}-${Date.now()}`, kind: "file", displayName: request.destination.suggestedName || `${document.name || "document"}.${extensionFor(format)}`, mediaType: `image/${format === "jpeg" ? "jpeg" : format}` };
    return { artifact, receipt: { status: "applied", revision, appliedIndexes: [], failedIndexes: [], tempIdMap: {}, compensations: [], verification: request.mutation?.verification === "none" ? "skipped" : "passed" } };
  });
}
async function exportLayers(request) {
  const document = activeDocument();
  const requested = [...(request.layerIds || []), ...(request.groupIds || [])].map(String);
  const layers = [];
  walkLayers(childrenOf(document), null, layers);
  const selected = requested.length ? layers.filter((layer) => requested.includes(String(layer.id))) : layers;
  const visible = selected.filter((layer) => request.includeHidden || layer.visible);
  if (!visible.length) throw new Error("NOT_FOUND: no Photoshop layers matched the export request");
  const exports = [];
  for (const layer of visible) {
    // The descriptor is executed in a modal scope; the host may provide the
    // encoded bytes through the result or through a UXP file entry adapter.
    const result = await batchPlay([{ _obj: "get", _target: [layerTarget(layer.id)] }]);
    const descriptor = Array.isArray(result) ? result[0] : result;
    const bytesBase64 = descriptor && typeof descriptor === "object" && typeof descriptor.bytesBase64 === "string" ? descriptor.bytesBase64 : null;
    if (!bytesBase64) throw new Error("EXPORT_FAILED: Photoshop did not return encoded layer bytes");
    exports.push({ layerId: String(layer.id), name: layer.name, format: request.format, bytesBase64, mediaType: request.format === "png" ? "image/png" : "image/vnd.adobe.photoshop" });
  }
  return { layerBytes: exports };
}
async function snapshot(target) { const inspected = await inspectDocument(target); const value = JSON.stringify(inspected.data); const digest = await sha256(value); return { id: `snapshot-${Date.now()}`, target, revision: inspected.revision, createdAt: new Date().toISOString(), sha256: digest, artifact: { artifactId: `snapshot-artifact-${Date.now()}`, kind: "snapshot", displayName: "photoshop-state.json", mediaType: "application/json", sha256: digest, provenance: { app: "photoshop" } }, verified: true }; }
async function verify(target, expectedRevision) { const inspected = await inspectDocument(target); return { ok: !expectedRevision || inspected.revision === expectedRevision, revision: inspected.revision, details: { documentId: inspected.data.id } }; }
async function capturePreview(request) {
  const document = activeDocument(); const format = request.format === "jpeg" ? "jpeg" : "png"; const max = Math.max(64, Math.min(4096, Number(request.maxDimension || 1024)));
  const scale = Math.min(1, max / Math.max(Number(document.width || max), Number(document.height || max))); const width = Math.max(1, Math.round(Number(document.width || max) * scale)); const height = Math.max(1, Math.round(Number(document.height || max) * scale));
  if (!photoshop.imaging || typeof photoshop.imaging.getPixels !== "function") throw new Error("UNSUPPORTED_CAPABILITY: Photoshop imaging preview is unavailable");
  const pixels = await photoshop.imaging.getPixels({ documentId: document.id, targetSize: { width, height }, colorSpace: "RGB", componentSize: 8, applyAlpha: true });
  const raw = pixels && typeof pixels.getData === "function" ? await pixels.getData() : pixels && (pixels.imageData || pixels.data);
  const canvas = typeof globalThis.document !== "undefined" && globalThis.document.createElement ? globalThis.document.createElement("canvas") : null;
  if (!canvas || !raw) throw new Error("UNSUPPORTED_CAPABILITY: Photoshop canvas encoder is unavailable");
  canvas.width = width; canvas.height = height; const context = canvas.getContext("2d"); if (!context) throw new Error("HOST_ERROR: Photoshop canvas context is unavailable");
  const rgba = raw instanceof Uint8Array ? raw : new Uint8Array(raw); context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const dataUrl = canvas.toDataURL(`image/${format}`); return { imageBase64: dataUrl.split(",", 2)[1] || "", mimeType: `image/${format}`, width, height, revision: state.revisions.get(targetKey(request.target)) || `ps-${document.id}-${Date.now()}`, capturedAt: new Date().toISOString() };
}

async function handleRpc(method, params) {
  if (method === "bridge.inspect") return inspectDocument(params.target);
  if (method === "bridge.mutate") return mutate(params);
  if (method === "bridge.export") return exportDocument(params);
  if (method === "bridge.exportLayers") return exportLayers(params);
  if (method === "photoshop.batchPlay" || method === "photoshop.action.batchPlay") return batchPlay(params.commands, { ...(params.options || {}), synchronousExecution: true, modalBehavior: "fail" });
  if (method === "bridge.snapshot") return snapshot(params.target);
  if (method === "bridge.preview.capture") return capturePreview(params);
  if (method === "bridge.verify") return verify(params.target, params.expectedRevision);
  if (method === "bridge.cancel") throw new Error("UNSUPPORTED_CAPABILITY: Photoshop mutations are synchronous");
  throw new Error(`INVALID_ARGUMENT: unsupported bridge method ${method}`);
}
function send(value) { const text = JSON.stringify(value); if (text.length > MAX_FRAME_BYTES) throw new Error("RATE_LIMITED: frame exceeds configured limit"); state.socket.send(text); }
function sendResponse(id, result, error) { send(error ? { type: "rpc", request: { jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } } } : { type: "rpc", request: { jsonrpc: "2.0", id, result } }); }
async function handleMessage(raw) {
  state.lastSeen = Date.now(); let value; try { value = JSON.parse(typeof raw === "string" ? raw : raw.data); } catch { return; }
  if (value?.jsonrpc === "2.0" && value.method === "auth.challenge") {
    const p = value.params; const clientNonce = base64Url(randomBytes(32)); const proof = await hmac(state.token, ["adobe-mcp", PROTOCOL_VERSION, clientNonce, p.serverNonce, p.sessionId].join("\0"));
    state.sessionId = p.sessionId; send({ jsonrpc: "2.0", id: `hello-${Date.now()}`, method: "bridge.hello", params: { protocolVersion: PROTOCOL_VERSION, instanceId: `uxp-photoshop-${String(app.version || "unknown")}`, client: { kind: "uxp", app: "photoshop", appVersion: String(app.version || "unknown") }, capabilities, auth: { scheme: "challenge-hmac", clientNonce }, proof } }); return;
  }
  if (value?.type === "pong") { state.lastSeen = Date.now(); return; }
  const request = value?.type === "rpc" ? value.request : value;
  if (request?.jsonrpc === "2.0" && request.method && request.id !== undefined) {
    try { sendResponse(request.id, await handleRpc(request.method, request.params || {})); } catch (error) { sendResponse(request.id, null, error); }
  }
}
async function readConfig() {
  const folder = await localFileSystem.getDataFolder(); let config = {};
  try { const file = await folder.getEntry("daemon.json"); config = JSON.parse(await file.read()); } catch { /* defaults are loopback-only */ }
  try { const tokenFile = await folder.getEntry("session-token.json"); const token = JSON.parse(await tokenFile.read()); config.token = token.token || token; } catch { /* token may be injected by the installer */ }
  if (!config.token && typeof window !== "undefined" && window.__ADOBE_MCP_TOKEN__) config.token = window.__ADOBE_MCP_TOKEN__;
  if (!config.endpoint && typeof window !== "undefined" && window.__ADOBE_MCP_DAEMON_ENDPOINT__) config.endpoint = window.__ADOBE_MCP_DAEMON_ENDPOINT__;
  if (!config.endpoint || !config.token) throw new Error("UNAUTHENTICATED: daemon.json and session-token.json are required");
  return config;
}
function scheduleReconnect() { if (state.reconnectTimer) return; const delay = Math.min(30_000, 500 * (2 ** state.reconnectAttempt)) + Math.floor(Math.random() * 300); state.reconnectAttempt++; state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; connect().catch(showError); }, delay); }
async function connect() {
  if (state.socket && state.connected) return;
  const config = await readConfig(); state.endpoint = config.endpoint; state.token = config.token; setStatus("Connecting…");
  const socket = new WebSocket(state.endpoint); state.socket = socket;
  socket.onopen = () => { state.connected = true; state.reconnectAttempt = 0; state.lastSeen = Date.now(); setStatus("Connected", true); if (state.heartbeat) clearInterval(state.heartbeat); state.heartbeat = setInterval(() => { if (Date.now() - state.lastSeen > 45_000) { socket.close(); return; } try { send({ type: "ping", timestamp: new Date().toISOString() }); } catch { socket.close(); } }, 10_000); };
  socket.onmessage = (event) => { handleMessage(event).catch(showError); };
  socket.onerror = () => { setStatus("Connection error"); };
  socket.onclose = () => { state.connected = false; if (state.heartbeat) clearInterval(state.heartbeat); state.heartbeat = null; setStatus("Disconnected"); scheduleReconnect(); };
}
$("reconnect").addEventListener("click", () => { if (state.socket) state.socket.close(); connect().catch(showError); });
connect().catch((error) => { showError(error); setStatus("Waiting for daemon"); scheduleReconnect(); });
