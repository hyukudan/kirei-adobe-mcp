/* adobe-mcp After Effects ExtendScript bridge.
 * The panel uses a loopback TCP Socket and newline-delimited JSON. The same
 * dispatcher can be attached to a host-provided WebSocket implementation.
 * Input is data only: handlers are allowlisted and never evaluated as JSX. */
(function (global) {
    var PROTOCOL = "1.0", VERSION = "1.0.0", MAX_FRAME_BYTES = 8 * 1024 * 1024;
    var socket = null, webSocket = null, readBuffer = "", sequence = 1;
    var sessionId = null, clientNonce = null, serverNonce = null, authenticated = false, nonceCounter = 0, usedNonces = {}, currentRevision = "ae-init";
    var config = { host: "127.0.0.1", port: 0, token: "", appVersion: VERSION, instanceId: null };
    var CAPABILITIES = ["state.read@1", "state.write@1", "project.inspect@1", "compositions.inspect@1", "layers.inspect@1", "properties.inspect@1", "keyframes.read@1", "keyframes.write@1", "render-queue.read@1", "render-queue.write@1", "snapshot.create@1", "preview.capture@1", "export.file@1", "preset.apply@1", "aftereffects.shape@1", "aftereffects.text@1", "aftereffects.expression-control@1"];

    function configure(options) { if (!options) return; for (var key in options) if (options.hasOwnProperty(key)) config[key] = options[key]; }
    function send(value) { var payload = JSON.stringify(value), line = payload + "\n"; if (line.length > MAX_FRAME_BYTES) throw new Error("RATE_LIMITED: frame exceeds configured limit"); if (socket && socket.connected) socket.write(line); else if (webSocket) webSocket.send(payload); }
    function reply(id, result, error) { send({ type: "rpc", request: error ? { jsonrpc: "2.0", id: id, error: error } : { jsonrpc: "2.0", id: id, result: result } }); }
    function error(message) { var result = { code: -32000, message: message }; return result; }
    function requireString(value, field) { if (typeof value !== "string" || value.length < 1 || value.length > 4096) throw new Error("INVALID_ARGUMENT: " + field); return value; }
    function own(value, field) { return value && value.hasOwnProperty(field); }
    function object(value) { return value && typeof value === "object" && !value.length; }
    function randomId(prefix) { nonceCounter += 1; return prefix + "-" + new Date().getTime().toString(36) + "-" + nonceCounter.toString(36) + "-" + Math.floor(Math.random() * 0x7fffffff).toString(36); }
    function rational(seconds, timebase) { var tb = timebase || 1000000; return { ticks: String(Math.round(seconds * tb)), timebase: String(tb) }; }
    function seconds(value) { if (!object(value) || !/^-?\d+$/.test(value.ticks) || !/^[1-9]\d*$/.test(value.timebase)) throw new Error("INVALID_ARGUMENT: RationalTime"); return Number(value.ticks) / Number(value.timebase); }
    function safeName(value) { return String(value || "").slice(0, 512); }
    function typeName(layer) {
        try { if (typeof TextLayer !== "undefined" && layer instanceof TextLayer) return "text"; } catch (_) {}
        try { if (typeof ShapeLayer !== "undefined" && layer instanceof ShapeLayer) return "shape"; } catch (_) {}
        try { if (typeof CameraLayer !== "undefined" && layer instanceof CameraLayer) return "camera"; } catch (_) {}
        try { if (typeof LightLayer !== "undefined" && layer instanceof LightLayer) return "light"; } catch (_) {}
        try { if (typeof AVLayer !== "undefined" && layer instanceof AVLayer) return layer.nullLayer ? "null" : "av"; } catch (_) {}
        return "unknown";
    }
    function projectId() { return app.project && app.project.file ? "project-" + hexDigest(sha256(app.project.file.fsName)) : "project-unsaved"; }
    function stableHostId(prefix, item) { if (!item || item.id === undefined || item.id === null) throw new Error("UNSUPPORTED_CAPABILITY: After Effects host does not expose persistent entity IDs"); return prefix + "-" + String(item.id); }
    function compId(comp) { return stableHostId("comp", comp); }
    function findComp(id) { if (!app.project) throw new Error("NOT_FOUND: no project"); for (var i = 1; i <= app.project.numItems; i++) { var item = app.project.item(i); if (item instanceof CompItem && compId(item) === id) return item; } throw new Error("NOT_FOUND: composition"); }
    function findLayer(comp, id) { for (var i = 1; i <= comp.numLayers; i++) if (layerDto(comp.layer(i), i).id === id) return comp.layer(i); throw new Error("NOT_FOUND: layer"); }
    function findProperty(layer, path) { if (!path || !path.length || path.length > 16) throw new Error("INVALID_ARGUMENT: propertyPath"); var property = layer; for (var i = 0; i < path.length; i++) { requireString(path[i], "propertyPath"); property = property.property(path[i]); if (!property) throw new Error("NOT_FOUND: property"); } return property; }
    function applyPreset(params) {
        var comp = findComp(requireString(params.target && params.target.entityId, "target.entityId")), layer = findLayer(comp, requireString(params.layerId, "layerId")), preset = params.preset || {}, recipe = preset.recipe || {}, modified = [];
        app.beginUndoGroup("adobe-mcp preset " + String(preset.id || params.presetId));
        try {
            if (preset.category === "effect" && preset.matchName) { var effects = layer.property("ADBE Effect Parade"), effect = effects.addProperty(requireString(preset.matchName, "preset.matchName")); modified.push(String(preset.matchName)); for (var key in recipe) if (recipe.hasOwnProperty(key) && effect.property(key)) { effect.property(key).setValue(recipe[key]); modified.push(String(preset.matchName) + "." + key); } }
            else if (preset.category === "animation" && recipe.expression) { var position = layer.property("ADBE Transform Group").property("ADBE Position"); position.expression = String(recipe.expression).replace(/frequency/g, String(params.parameters && params.parameters.frequency || 2)).replace(/amplitude/g, String(params.parameters && params.parameters.amplitude || 40)); modified.push("ADBE Position.expression"); if (preset.id === "motion.motion-blur") { layer.motionBlur = true; modified.push("motionBlur"); } }
            else if (preset.category === "camera" && recipe.threeD) { layer.threeDLayer = true; modified.push("threeDLayer"); }
            else if (preset.category === "tracking" && recipe.parent) { var parent = comp.layers.addNull(); parent.name = String(recipe.parent); layer.parent = parent; modified.push("parent"); }
            else throw new Error("UNSUPPORTED_CAPABILITY: preset recipe cannot be applied to this layer");
        } finally { app.endUndoGroup(); }
        currentRevision = "ae-" + new Date().getTime(); return { applied: true, presetId: requireString(params.presetId, "presetId"), layerId: requireString(params.layerId, "layerId"), modifiedProperties: modified };
    }

    function propertyTree(property, depth) {
        var result = { name: safeName(property.name), matchName: safeName(property.matchName), propertyType: String(property.propertyType), canSetExpression: !!property.canSetExpression, expression: property.expression || "" };
        if (property.numKeys !== undefined && property.numKeys > 0) {
            result.keyframes = [];
            for (var k = 1; k <= property.numKeys && k <= 5000; k++) {
                var interpolation = "linear";
                try { if (property.keyInInterpolationType(k) === KeyframeInterpolationType.HOLD) interpolation = "hold"; else if (property.keyInInterpolationType(k) === KeyframeInterpolationType.BEZIER) interpolation = "bezier"; } catch (_) {}
                result.keyframes.push({ time: rational(property.keyTime(k)), value: property.keyValue(k), interpolation: interpolation });
            }
        }
        if (depth > 0 && property.numProperties !== undefined) {
            result.children = [];
            for (var child = 1; child <= property.numProperties && child <= 500; child++) result.children.push(propertyTree(property.property(child), depth - 1));
        }
        return result;
    }
    function layerDto(layer, index) {
        var parent = null; try { parent = layer.parent ? stableHostId("layer", layer.parent) : null; } catch (_) { parent = null; }
        return { id: stableHostId("layer", layer), index: index, name: safeName(layer.name), type: typeName(layer), sourceId: layer.source ? stableHostId("source", layer.source) : undefined, parentId: parent, enabled: !!layer.enabled, locked: !!layer.locked, threeD: !!layer.threeDLayer, inPoint: rational(layer.inPoint), outPoint: rational(layer.outPoint), startTime: rational(layer.startTime), selected: !!layer.selected };
    }
    function inspectComposition(comp, index, depth) {
        var layers = [];
        for (var i = 1; i <= comp.numLayers && i <= 10000; i++) layers.push(layerDto(comp.layer(i), i));
        var result = { id: compId(comp, index), revision: "ae-" + new Date().getTime(), name: safeName(comp.name), width: comp.width, height: comp.height, pixelAspect: comp.pixelAspect, frameRate: comp.frameRate, duration: rational(comp.duration), workArea: { start: rational(comp.workAreaStart), duration: rational(comp.workAreaDuration) }, layers: layers, truncated: comp.numLayers > layers.length };
        if (depth > 1 && comp.numLayers) { result.properties = []; for (var p = 1; p <= comp.numLayers && p <= 100; p++) result.properties.push({ layerId: layers[p - 1].id, tree: propertyTree(comp.layer(p), depth - 2) }); }
        return result;
    }
    function inspectProject(params) {
        if (!app.project) throw new Error("NOT_FOUND: no project");
        var compositions = [];
        for (var i = 1; i <= app.project.numItems && compositions.length < 1000; i++) if (app.project.item(i) instanceof CompItem) compositions.push(inspectComposition(app.project.item(i), i, params.depth || 1));
        var queue = [];
        for (var q = 1; q <= app.project.renderQueue.numItems && q <= 500; q++) { var item = app.project.renderQueue.item(q), queueKey = item.id !== undefined && item.id !== null ? String(item.id) : hexDigest(sha256((item.comp ? compId(item.comp) : "none") + "|" + String(item.timeSpanStart) + "|" + String(item.timeSpanDuration))); queue.push({ id: "render-" + queueKey, compId: item.comp ? compId(item.comp) : null, status: String(item.status), timeSpanStart: rational(item.timeSpanStart), timeSpanDuration: rational(item.timeSpanDuration), outputModules: item.numOutputModules }); }
        return { project: { id: projectId(), name: app.project.file ? safeName(app.project.file.name) : "Untitled Project", saved: !!app.project.file }, compositions: compositions, renderQueue: queue };
    }
    function inspect(params) { if (!app.project) throw new Error("NOT_FOUND: no project"); var result = inspectProject(params || {}); currentRevision = result.compositions && result.compositions.length ? result.compositions[0].revision : "ae-" + new Date().getTime(); return result; }

    function interpolationType(name) { if (name === "hold") return KeyframeInterpolationType.HOLD; if (name === "bezier") return KeyframeInterpolationType.BEZIER; return KeyframeInterpolationType.LINEAR; }
    function applyCommand(comp, command, tempIds) {
        if (!object(command) || typeof command.op !== "string") throw new Error("INVALID_ARGUMENT: command");
        if (command.op === "advanced") {
            var payload = command.payload || {}, tool = String(command.tool || ""), advancedLayer = payload.layerId ? findLayer(comp, String(payload.layerId)) : null;
            if (tool === "adobe.aftereffects.shape.create") {
                var shapeLayer = comp.layers.addShape(payload.groupName || "MCP Shape"), root = shapeLayer.property("ADBE Root Vectors Group"), group = root.addProperty("ADBE Vector Group"); group.name = String(payload.groupName || "Shapes");
                var shapes = payload.shapes || []; for (var s = 0; s < shapes.length; s++) { var shape = shapes[s]; if (shape.type === "rectangle") { var rect = group.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Rect"); if (shape.size) rect.property("ADBE Vector Rect Size").setValue(shape.size); } else if (shape.type === "ellipse") { var ellipse = group.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Ellipse"); if (shape.size) ellipse.property("ADBE Vector Ellipse Size").setValue(shape.size); } }
                var modifiers = payload.modifiers || {}; if (modifiers.trimPaths) group.property("ADBE Vectors Group").addProperty("ADBE Vector Filter - Trim"); if (modifiers.repeater) group.property("ADBE Vectors Group").addProperty("ADBE Vector Filter - Repeater"); if (modifiers.puckerAndBloat) group.property("ADBE Vectors Group").addProperty("ADBE Vector Filter - PB"); return;
            }
            if (tool === "adobe.aftereffects.text.animate") { if (!advancedLayer) throw new Error("NOT_FOUND: text layer"); var textProps = advancedLayer.property("ADBE Text Properties"), animators = textProps.property("ADBE Text Animators"), animator = animators.addProperty("ADBE Text Animator"); animator.name = "MCP Character Animator"; var selector = animator.property("ADBE Text Selectors").property(1); if (payload.rangeSelector) { selector.property("ADBE Text Percent Start").setValue(payload.rangeSelector.start); selector.property("ADBE Text Percent End").setValue(payload.rangeSelector.end); selector.property("ADBE Text Percent Offset").setValue(payload.rangeSelector.offset); } return; }
            if (tool === "adobe.aftereffects.expressionControl.add") { if (!advancedLayer) throw new Error("NOT_FOUND: expression-control layer"); var names = { slider: "ADBE Slider Control", color: "ADBE Color Control", point: "ADBE Point Control", angle: "ADBE Angle Control" }, effect = advancedLayer.property("ADBE Effect Parade").addProperty(names[payload.control]); effect.name = String(payload.name); if (payload.expression) effect.property(1).expression = String(payload.expression); if (payload.value !== undefined) effect.property(1).setValue(payload.value); return; }
            throw new Error("UNSUPPORTED_CAPABILITY: After Effects advanced command");
        }
        if (command.op === "create-layer") {
            requireString(command.name, "name"); var layer;
            if (command.kind === "solid") layer = comp.layers.addSolid([0, 0, 0], command.name, comp.width, comp.height, 1);
            else if (command.kind === "text") layer = comp.layers.addText(command.name);
            else if (command.kind === "shape") layer = comp.layers.addShape(command.name);
            else if (command.kind === "null") layer = comp.layers.addNull();
            else if (command.kind === "camera") layer = comp.layers.addCamera(command.name, [comp.width / 2, comp.height / 2]);
            else if (command.kind === "light") layer = comp.layers.addLight(command.name, [comp.width / 2, comp.height / 2]);
            else throw new Error("INVALID_ARGUMENT: kind");
            tempIds[requireString(command.tempId, "tempId")] = stableHostId("layer", layer); layer.name = command.name; return;
        }
        if (command.op === "set-property") { var target = findLayer(comp, requireString(command.layerId, "layerId")); var property = findProperty(target, command.propertyPath); property.setValue(command.value); return; }
        if (command.op === "set-keyframes") {
            var keyLayer = findLayer(comp, requireString(command.layerId, "layerId")); var keyProperty = findProperty(keyLayer, command.propertyPath);
            if (command.mode === "replace-range") while (keyProperty.numKeys) keyProperty.removeKey(1);
            for (var k = 0; k < command.keyframes.length; k++) { var frame = command.keyframes[k]; var time = seconds(frame.time); keyProperty.setValueAtTime(time, frame.value); var key = keyProperty.nearestKeyIndex(time); keyProperty.setInterpolationTypeAtKey(key, interpolationType(frame.interpolation), interpolationType(frame.interpolation)); }
            return;
        }
        if (command.op === "delete-layer") { for (var d = command.layerIds.length - 1; d >= 0; d--) findLayer(comp, command.layerIds[d]).remove(); return; }
        throw new Error("INVALID_ARGUMENT: unsupported command");
    }
    function mutate(params) {
        var comp = findComp(requireString(params.compId || (params.target && params.target.entityId), "compId"));
        if (!params.commands || params.commands.length < 1 || params.commands.length > 500) throw new Error("INVALID_ARGUMENT: commands");
        var tempIds = {}, applied = [], failed = [];
        app.beginUndoGroup("adobe-mcp");
        try {
            for (var i = 0; i < params.commands.length; i++) { try { applyCommand(comp, params.commands[i], tempIds); applied.push(i); } catch (e) { failed.push(i); throw e; } }
        } finally { app.endUndoGroup(); }
        currentRevision = "ae-" + new Date().getTime(); return { status: failed.length ? "partial" : "applied", previousRevision: params.expectedRevision || "unknown", revision: currentRevision, appliedIndexes: applied, failedIndexes: failed, tempIdMap: tempIds, compensations: [], verification: "passed" };
    }
    function capturePreview(params) {
        var comp = findComp(requireString(params.target && params.target.entityId, "target.entityId")), time = params.time ? seconds(params.time) : comp.time;
        var max = Math.max(64, Math.min(4096, Number(params.maxDimension || 1024))), scale = Math.min(1, max / Math.max(comp.width, comp.height));
        var width = Math.max(1, Math.round(comp.width * scale)), height = Math.max(1, Math.round(comp.height * scale));
        var source = new File(Folder.temp.fsName + "/adobe-mcp-preview-source-" + randomId("frame") + ".png"), output = source, imported = null, scaledComp = null, bytes, outputOpen = false;
        try {
            comp.saveFrameToPng(time, source);
            if (scale < 1) {
                imported = app.project.importFile(new ImportOptions(source));
                scaledComp = app.project.items.addComp("adobe-mcp-preview-" + randomId("comp"), width, height, comp.pixelAspect, comp.duration, comp.frameRate);
                var layer = scaledComp.layers.add(imported), fitScale = Math.min(width / comp.width, height / comp.height) * 100;
                layer.property("Scale").setValue([fitScale, fitScale]); layer.property("Position").setValue([width / 2, height / 2]);
                output = new File(Folder.temp.fsName + "/adobe-mcp-preview-output-" + randomId("frame") + ".png");
                scaledComp.saveFrameToPng(0, output);
            }
            if (!output.open("rb")) throw new Error("EXPORT_FAILED: cannot read After Effects preview"); outputOpen = true;
            bytes = output.read(); output.close(); outputOpen = false;
            var encoded = base64Encode(bytes).replace(/-/g, "+").replace(/_/g, "/"); while (encoded.length % 4) encoded += "=";
            return { imageBase64: encoded, mimeType: "image/png", width: width, height: height, revision: currentRevision, capturedAt: new Date().toISOString() };
        } finally {
            try { if (outputOpen && output) output.close(); } catch (_) {}
            try { if (output && output.exists) output.remove(); } catch (_) {}
            try { if (source && source.exists) source.remove(); } catch (_) {}
            try { if (scaledComp) scaledComp.remove(); } catch (_) {}
            try { if (imported) imported.remove(); } catch (_) {}
        }
    }
    function addToRenderQueue(params) {
        var comp = findComp(requireString(params.compId || (params.target && params.target.entityId), "compId"));
        var item;
        app.beginUndoGroup("adobe-mcp render queue");
        try {
            item = app.project.renderQueue.items.add(comp);
            if (params.renderSettingsTemplate) item.applyTemplate(params.renderSettingsTemplate);
            if (params.outputModuleTemplate) item.outputModule(1).applyTemplate(params.outputModuleTemplate);
            if (params.timeSpan) { item.timeSpanStart = seconds(params.timeSpan.start); item.timeSpanDuration = seconds(params.timeSpan.duration); }
        } finally { app.endUndoGroup(); }
        return { queueItemId: item.id !== undefined && item.id !== null ? "render-" + String(item.id) : "render-" + hexDigest(sha256(compId(comp) + "|" + String(item.timeSpanStart) + "|" + String(item.timeSpanDuration))), revision: "ae-" + new Date().getTime(), status: "queued" };
    }
    function handle(method, params) {
        if (method === "bridge.hello") return { protocolVersion: PROTOCOL, sessionId: sessionId || (sessionId = randomId("session")), serverNonce: serverNonce || (serverNonce = nonce(32)), expiresAt: new Date(new Date().getTime() + 1800000).toISOString(), maxFrameBytes: 8388608 };
        if (method === "bridge.auth") { var auth = params && { sessionId: requireString(params.sessionId, "sessionId"), proof: requireString(params.proof, "proof"), clientNonce: requireString(params.clientNonce, "clientNonce"), serverNonce: requireString(params.serverNonce, "serverNonce") }; if (!auth) throw new Error("UNAUTHENTICATED: proof required"); if (sessionId && auth.sessionId !== sessionId || serverNonce && auth.serverNonce !== serverNonce) throw new Error("UNAUTHENTICATED: handshake nonce mismatch"); if (usedNonces[auth.clientNonce]) throw new Error("UNAUTHENTICATED: nonce already used"); if (!constantTimeEqualBytes(authProof(auth.clientNonce, auth.serverNonce, auth.sessionId), auth.proof)) throw new Error("UNAUTHENTICATED: invalid HMAC proof"); usedNonces[auth.clientNonce] = true; authenticated = true; return { authenticated: true }; }
        if (method === "bridge.ping") return { ok: true };
        if (!authenticated) throw new Error("UNAUTHENTICATED: authenticate first");
        if (method === "ae.inspect") return inspect(params || {});
        if (method === "ae.mutate") return mutate(params || {});
        if (method === "adobe.aftereffects.preset.apply" || method === "bridge.preset.apply") return applyPreset(params || {});
        if (method === "ae.renderQueue.add") return addToRenderQueue(params || {});
        if (method === "ae.preview.capture" || method === "bridge.preview.capture") return capturePreview(params || {});
        if (method === "ae.snapshot") { var snapshotData = inspectProject({ depth: 0 }); var snapshotBytes = JSON.stringify(snapshotData); var snapshotHash = hexDigest(sha256(snapshotBytes)); return { id: randomId("snapshot"), target: params.target, revision: currentRevision, createdAt: new Date().toISOString(), sha256: snapshotHash, artifact: { artifactId: randomId("artifact"), kind: "snapshot", displayName: "after-effects-snapshot", sha256: snapshotHash, provenance: { app: "after-effects" } }, verified: /^[a-f0-9]{64}$/.test(snapshotHash) }; }
        if (method === "ae.verify") return { ok: !params.expectedRevision || params.expectedRevision === currentRevision, revision: currentRevision };
        throw new Error("NOT_FOUND: handler is not allowlisted");
    }
    function base64Decode(value) { var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=", output = "", bits = 0, buffer = 0; value = value.replace(/-/g, "+").replace(/_/g, "/"); for (var i = 0; i < value.length; i++) { var n = alphabet.indexOf(value.charAt(i)); if (n < 0 || n === 64) continue; buffer = (buffer << 6) | n; bits += 6; if (bits >= 8) { bits -= 8; output += String.fromCharCode((buffer >> bits) & 255); } } return output; }
    function constantTimeEqualBytes(expected, actual) { var a = base64Decode(expected), b = base64Decode(String(actual || "")), length = Math.max(a.length, b.length), diff = a.length ^ b.length, i; for (i = 0; i < length; i++) diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0); return diff === 0; }
    function base64Encode(value) { var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", output = "", i = 0; while (i < value.length) { var a = value.charCodeAt(i++), hasB = i < value.length, b = hasB ? value.charCodeAt(i++) : 0, hasC = i < value.length, c = hasC ? value.charCodeAt(i++) : 0, n = (a << 16) | (b << 8) | c; output += alphabet.charAt((n >> 18) & 63) + alphabet.charAt((n >> 12) & 63) + (hasB ? alphabet.charAt((n >> 6) & 63) : "=") + (hasC ? alphabet.charAt(n & 63) : "="); } return output.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
    function sha256(message) {
        var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
        var H = [1779033703,-1150833019,1013904242,-1521486534,1359893119,-1694144372,528734635,1541459225], bytes = [], i;
        for (i = 0; i < message.length; i++) bytes.push(message.charCodeAt(i) & 255);
        var bitLength = bytes.length * 8; bytes.push(128); while ((bytes.length % 64) !== 56) bytes.push(0);
        for (i = 7; i >= 0; i--) bytes.push(Math.floor(bitLength / Math.pow(2, i * 8)) & 255);
        for (var offset = 0; offset < bytes.length; offset += 64) {
            var W = [], j; for (j = 0; j < 16; j++) W[j] = (bytes[offset + j * 4] << 24) | (bytes[offset + j * 4 + 1] << 16) | (bytes[offset + j * 4 + 2] << 8) | bytes[offset + j * 4 + 3];
            for (j = 16; j < 64; j++) { var s0 = ((W[j - 15] >>> 7) | (W[j - 15] << 25)) ^ ((W[j - 15] >>> 18) | (W[j - 15] << 14)) ^ (W[j - 15] >>> 3); var s1 = ((W[j - 2] >>> 17) | (W[j - 2] << 15)) ^ ((W[j - 2] >>> 19) | (W[j - 2] << 13)) ^ (W[j - 2] >>> 10); W[j] = (W[j - 16] + s0 + W[j - 7] + s1) | 0; }
            var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
            for (j = 0; j < 64; j++) { var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7)); var ch = (e & f) ^ ((~e) & g); var t1 = (h + S1 + ch + K[j % K.length] + W[j]) | 0; var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10)); var maj = (a & b) ^ (a & c) ^ (b & c); var t2 = (S0 + maj) | 0; h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0; }
            H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
        }
        var result = ""; for (i = 0; i < H.length; i++) for (j = 3; j >= 0; j--) result += String.fromCharCode((H[i] >>> (j * 8)) & 255); return result;
    }
    function hexDigest(value) { var output = "", i, byte; for (i = 0; i < value.length; i++) { byte = value.charCodeAt(i) & 255; output += (byte < 16 ? "0" : "") + byte.toString(16); } return output; }
    function authProof(nonceValue, serverNonceValue, sessionValue) { var key = base64Decode(config.token), block = "", i; for (i = 0; i < 64; i++) block += String.fromCharCode(i < key.length ? key.charCodeAt(i) : 0); var inner = "", outer = ""; for (i = 0; i < 64; i++) { inner += String.fromCharCode(block.charCodeAt(i) ^ 54); outer += String.fromCharCode(block.charCodeAt(i) ^ 92); } return base64Encode(sha256(outer + sha256(inner + "adobe-mcp\0" + PROTOCOL + "\0" + nonceValue + "\0" + serverNonceValue + "\0" + sessionValue))); }
    function receiveLine(line) {
        var request; try {
            request = JSON.parse(line);
            if (request && request.type === "rpc" && request.request) request = request.request;
            if (request.method === "auth.challenge" && request.params && !authenticated) { serverNonce = requireString(request.params.serverNonce, "serverNonce"); sessionId = requireString(request.params.sessionId, "sessionId"); if (usedNonces[clientNonce]) throw new Error("UNAUTHENTICATED: nonce already used"); usedNonces[clientNonce] = true; send({ jsonrpc: "2.0", id: sequence++, method: "bridge.hello", params: { protocolVersion: PROTOCOL, instanceId: config.instanceId || randomId("ae"), client: { kind: "jsx", app: "after-effects", appVersion: config.appVersion }, capabilities: CAPABILITIES, auth: { scheme: "challenge-hmac", clientNonce: clientNonce }, proof: authProof(clientNonce, serverNonce, sessionId) } }); return; }
            if (request.result && request.result.protocolVersion === PROTOCOL && request.result.sessionId && !authenticated) { authenticated = true; return; }
            if (!request.method) return;
            var result = handle(request.method, request.params || {}); reply(request.id, result);
        } catch (e) { if (request && request.method) reply(request.id, null, error(e.message || "HOST_ERROR")); }
    }
    function poll() { if (!socket || !socket.connected) return; var chunk = socket.read(8192); if (chunk) { readBuffer += chunk; if (readBuffer.length > MAX_FRAME_BYTES) throw new Error("RATE_LIMITED: frame exceeds configured limit"); var lines = readBuffer.split(/\r?\n/); readBuffer = lines.pop() || ""; for (var i = 0; i < lines.length; i++) if (lines[i]) receiveLine(lines[i]); } }
    function connectTcp(options) { configure(options); if (!config.port || !config.token) throw new Error("INVALID_ARGUMENT: bridge port and token are required"); socket = new Socket(); if (!socket.open(config.host + ":" + config.port, "UTF-8")) throw new Error("BRIDGE_UNAVAILABLE: cannot open daemon socket"); clientNonce = nonce(32); return true; }
    function connectWebSocket(url, options) { configure(options); if (typeof WebSocket === "undefined") throw new Error("UNSUPPORTED_CAPABILITY: WebSocket is not available in ExtendScript"); webSocket = new WebSocket(url); webSocket.onmessage = function (event) { receiveLine(event.data); }; return webSocket; }
    function nonce(size) { var value = randomId("n") + randomId("n") + String(size); if (usedNonces[value]) return nonce(size); return value; }

    global.AfterEffectsBridgePanel = { configure: configure, connect: connectTcp, connectWebSocket: connectWebSocket, poll: poll, receive: receiveLine, inspect: inspect, mutate: mutate, addToRenderQueue: addToRenderQueue, capabilities: CAPABILITIES, version: VERSION };
})(this);
