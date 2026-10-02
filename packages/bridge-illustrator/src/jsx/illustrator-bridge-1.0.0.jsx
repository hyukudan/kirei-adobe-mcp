/* Adobe MCP Illustrator fallback bridge v1.0.0.
 * The daemon invokes only the named handlers below with a JSON payload.
 * This file intentionally has no eval, no Function constructor and no shell/file-path input.
 */
#target illustrator
(function (root) {
    var VERSION = "1.0.0";
    var ALLOWED = {
        inspect: true,
        "create-layer": true,
        "create-item": true,
        transform: true,
        "delete": true,
        "export": true,
        snapshot: true,
        verify: true
    };

    function fail(code, message) { return { ok: false, error: { code: code, message: message } }; }
    function id(prefix, object) {
        if (object && object.uuid) return String(object.uuid);
        if (object && object.id !== undefined && object.id !== null) return prefix + ":" + String(object.id);
        if (object && typeof object.note === "string" && object.note.indexOf("adobe-mcp:") === 0) return object.note.slice("adobe-mcp:".length);
        if (object && typeof object.note === "string") { var generated = prefix + ":" + String(Date.now()) + ":" + String(Math.random()).slice(2); object.note = "adobe-mcp:" + generated; return generated; }
        throw new Error("UNSUPPORTED_CAPABILITY: Illustrator object has no persistent identifier");
    }
    function boundsOf(item) {
        var b = item.geometricBounds || [0, 0, 0, 0];
        return { left: Number(b[0]), top: Number(b[1]), right: Number(b[2]), bottom: Number(b[3]), unit: "pt" };
    }
    function itemType(item) {
        var n = String(item.typename || "").toLowerCase();
        if (n.indexOf("compound") >= 0) return "compound-path";
        if (n === "pathitem") return "path";
        if (n === "groupitem") return "group";
        if (n === "textframe") return "text";
        if (n === "placeditem") return "placed";
        if (n === "rasteritem") return "raster";
        if (n === "symbolitem") return "symbol";
        if (n === "meshitem") return "mesh";
        return "unknown";
    }
    function colorSpace(document) { return String(document.documentColorSpace || "RGB").toLowerCase().indexOf("cmyk") >= 0 ? "cmyk" : "rgb"; }
    function collectItems(collection, layerId, parentId, output, limit) {
        for (var i = 0; i < collection.length && output.length < limit; i += 1) {
            var item = collection[i];
            var currentId = id("item", item);
            output.push({
                id: currentId, name: String(item.name || ""), type: itemType(item), layerId: layerId, parentId: parentId,
                bounds: boundsOf(item), visible: item.hidden !== true, locked: item.locked === true,
                selected: item.selected === true, opacity: Number(item.opacity === undefined ? 100 : item.opacity) / 100,
                geometry: item.pathPoints ? { pointCount: item.pathPoints.length, closed: item.closed === true } : undefined
            });
            if (item.typename === "GroupItem" && item.pageItems) collectItems(item.pageItems, layerId, currentId, output, limit);
        }
    }
    function inspect(payload) {
        var document = app.activeDocument;
        if (!document) return fail("APP_NOT_RUNNING", "No active Illustrator document");
        var limit = Math.max(1, Math.min(Number(payload.limit || 1000), 10000));
        var artboards = [];
        for (var a = 0; a < document.artboards.length; a += 1) {
            var board = document.artboards[a];
            artboards.push({ id: id("artboard", board), name: String(board.name || "Artboard " + (a + 1)), bounds: { left: board.artboardRect[0], top: board.artboardRect[1], right: board.artboardRect[2], bottom: board.artboardRect[3], unit: "pt" } });
        }
        var layers = [], items = [];
        for (var l = 0; l < document.layers.length; l += 1) {
            var layer = document.layers[l], layerId = id("layer", layer);
            layers.push({ id: layerId, name: String(layer.name || "Layer " + (l + 1)), visible: layer.visible !== false, locked: layer.locked === true, itemCount: layer.pageItems.length });
            collectItems(layer.pageItems, layerId, null, items, limit);
        }
        return { ok: true, version: VERSION, data: {
            id: id("document", document), revision: String(payload.revision || "ai-rev-0"), name: String(document.name || "Untitled"), saved: document.saved,
            colorSpace: colorSpace(document), activeArtboardId: document.artboards.length ? id("artboard", document.artboards[document.artboards.getActiveArtboardIndex()]) : "artboard:none",
            artboards: artboards, layers: layers, items: items, truncated: items.length >= limit, nextCursor: items.length >= limit ? String(limit) : undefined
        } };
    }
    function findLayer(payload) {
        var document = app.activeDocument;
        for (var i = 0; i < document.layers.length; i += 1) if (id("layer", document.layers[i]) === String(payload.layerId)) return document.layers[i];
        return null;
    }
    function findItem(payload) {
        var document = app.activeDocument, all = document.pageItems;
        for (var i = 0; i < all.length; i += 1) if (id("item", all[i]) === String(payload.itemId)) return all[i];
        return null;
    }
    function createItem(payload) {
        var layer = findLayer({ layerId: payload.layerId }) || app.activeDocument.activeLayer;
        var g = payload.geometry || {}, item, type = String(payload.itemType);
        if (type === "rectangle") item = layer.pathItems.rectangle(Number(g.top || 0), Number(g.left || 0), Number(g.width || 100), Number(g.height || 100));
        else if (type === "ellipse") item = layer.pathItems.ellipse(Number(g.top || 0), Number(g.left || 0), Number(g.width || 100), Number(g.height || 100));
        else if (type === "path") { item = layer.pathItems.add(); item.setEntirePath(g.points || [[0, 0], [100, 0], [100, 100]]); item.closed = g.closed === true; }
        else if (type === "text") { item = layer.textFrames.add(); item.contents = String(g.text || ""); item.position = [Number(g.x || 0), Number(g.y || 0)]; }
        else if (type === "group") item = layer.groupItems.add();
        else throw new Error("unsupported item type");
        item.name = String(g.name || payload.tempId || type);
        if (payload.style) { if (payload.style.opacity !== undefined) item.opacity = Number(payload.style.opacity) * 100; if (payload.style.hidden !== undefined) item.hidden = Boolean(payload.style.hidden); }
        return { tempId: String(payload.tempId), id: id("item", item) };
    }
    function transform(payload) {
        var matrix = payload.matrix || [1, 0, 0, 1, 0, 0], m = app.getIdentityMatrix();
        m.mValueA = Number(matrix[0]); m.mValueB = Number(matrix[1]); m.mValueC = Number(matrix[2]); m.mValueD = Number(matrix[3]); m.mValueTX = Number(matrix[4]); m.mValueTY = Number(matrix[5]);
        var changed = [];
        for (var i = 0; i < payload.itemIds.length; i += 1) { var item = findItem({ itemId: payload.itemIds[i] }); if (item) { item.transform(m, true, true, true, true, 1); changed.push(String(payload.itemIds[i])); } }
        return { changed: changed };
    }
    function mutate(payload) {
        var result = { applied: [], failed: [], tempIdMap: {} };
        var selection = app.activeDocument.selection;
        try {
            for (var i = 0; i < payload.commands.length; i += 1) {
                var command = payload.commands[i];
                try {
                    if (command.op === "create-layer") { var layer = app.activeDocument.layers.add(); layer.name = String(command.name); result.tempIdMap[command.tempId] = id("layer", layer); result.applied.push(i); }
                    else if (command.op === "create-item") { var created = createItem(command); result.tempIdMap[created.tempId] = created.id; result.applied.push(i); }
                    else if (command.op === "transform") { transform(command); result.applied.push(i); }
                    else if (command.op === "delete") { for (var d = 0; d < command.itemIds.length; d += 1) { var doomed = findItem({ itemId: command.itemIds[d] }); if (doomed) doomed.remove(); } result.applied.push(i); }
                    else result.failed.push(i);
                } catch (error) { result.failed.push(i); }
            }
        } finally {
            try { app.activeDocument.selection = selection; } catch (ignored) {}
        }
        return { ok: result.failed.length === 0, result: result };
    }
    function exportDocument(payload) {
        var document = app.activeDocument, format = String(payload.format), file = new File(String(payload.file));
        if (format === "ai") document.saveAs(file);
        else if (format === "svg") document.exportFile(file, ExportType.SVG, new ExportOptionsSVG());
        else if (format === "pdf") document.saveAs(file, new PDFSaveOptions());
        else if (format === "png") document.exportFile(file, ExportType.PNG24, new ExportOptionsPNG24());
        else if (format === "jpeg") document.exportFile(file, ExportType.JPEG, new ExportOptionsJPEG());
        else throw new Error("unsupported export format");
        return { artifactId: String(payload.artifactId || file.name), displayName: file.name, format: format };
    }
    function dispatch(handler, payload) {
        if (!ALLOWED[handler]) return fail("PERMISSION_DENIED", "JSX handler is not allowlisted");
        try {
            if (handler === "inspect") return inspect(payload || {});
            if (handler === "create-layer" || handler === "create-item" || handler === "transform" || handler === "delete") return mutate({ commands: [payload] });
            if (handler === "export") return { ok: true, artifact: exportDocument(payload || {}) };
            if (handler === "snapshot") return { ok: true, revision: String(payload.revision || "ai-rev-0"), document: inspect(payload || {}).data };
            if (handler === "verify") return { ok: true, revision: String(payload.revision || "ai-rev-0") };
        } catch (error) { return fail("HOST_ERROR", String(error)); }
        return fail("INVALID_ARGUMENT", "Unknown JSX handler");
    }
    root.AdobeMcpIllustrator = { version: VERSION, handlers: ALLOWED, dispatch: dispatch };
}(this));
