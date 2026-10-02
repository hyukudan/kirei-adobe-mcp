import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "./index.js";

describe("ArtifactStore", () => {
  it("stores immutable content-addressed bytes and resolves artifact URIs", async () => {
    const root = await mkdtemp(join(tmpdir(), "adobe-mcp-artifacts-"));
    const store = new ArtifactStore(root);
    const metadata = await store.put(new TextEncoder().encode("hello"), { mediaType: "text/plain", provenance: { app: "photoshop" } });
    expect(metadata.uri).toMatch(/^artifact:\/\/sha256-/);
    await expect(store.resolve(metadata.uri)).resolves.toMatchObject({ metadata, bytes: new TextEncoder().encode("hello") });
    await expect(readFile(join(root, "sha256", metadata.sha256.slice(0, 2), metadata.sha256))).resolves.toEqual(Buffer.from("hello"));
  });
  it("returns canonical metadata when the same bytes are put with conflicting metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "adobe-mcp-artifacts-conflict-"));
    const store = new ArtifactStore(root); const bytes = new TextEncoder().encode("same");
    const first = await store.put(bytes, { mediaType: "text/plain", provenance: { source: "first" } });
    const second = await store.put(bytes, { mediaType: "application/octet-stream", provenance: { source: "second" } });
    expect(second).toEqual(first);
    await expect(store.resolve(second.uri)).resolves.toMatchObject({ metadata: first });
  });
});
