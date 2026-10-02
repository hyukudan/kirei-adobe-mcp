import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ArtifactMetadata } from "@adobe-mcp/schemas";

export interface ArtifactPutOptions { readonly mediaType?: string; readonly provenance?: Record<string, unknown>; }
export interface StoredArtifact { readonly metadata: ReturnType<typeof ArtifactMetadata.parse>; readonly bytes: Uint8Array; }

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function validateDigest(value: string): void { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("INVALID_ARGUMENT: invalid SHA-256 digest"); }

/** Immutable, content-addressed artifact storage. A digest can only ever map to one byte sequence. */
export class ArtifactStore {
  constructor(private readonly root: string) {}
  uri(sha256: string): string { validateDigest(sha256); return `artifact://sha256-${sha256}`; }
  private dataPath(sha256: string): string { validateDigest(sha256); return join(this.root, "sha256", sha256.slice(0, 2), sha256); }
  private metadataPath(sha256: string): string { return `${this.dataPath(sha256)}.json`; }

  async put(bytes: Uint8Array, options: ArtifactPutOptions = {}): Promise<ReturnType<typeof ArtifactMetadata.parse>> {
    const sha256 = digest(bytes);
    const metadata = ArtifactMetadata.parse({ sha256, uri: this.uri(sha256), ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }), sizeBytes: bytes.byteLength, createdAt: new Date().toISOString(), immutable: true, provenance: options.provenance ?? {} });
    const dataPath = this.dataPath(sha256);
    await mkdir(dirname(dataPath), { recursive: true });
    try { await writeFile(dataPath, bytes, { flag: "wx" }); } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(dataPath); if (digest(existing) !== sha256) throw new Error("INTERNAL: content-addressed collision detected");
    }
    try { await writeFile(this.metadataPath(sha256), JSON.stringify(metadata), { flag: "wx" }); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stored = ArtifactMetadata.parse(JSON.parse(await readFile(this.metadataPath(sha256), "utf8")) as unknown);
      if (stored.sha256 !== sha256 || stored.uri !== this.uri(sha256) || stored.sizeBytes !== bytes.byteLength) throw new Error("VERIFICATION_FAILED: canonical artifact metadata does not match stored bytes");
      return stored;
    }
    return metadata;
  }
  async get(sha256: string): Promise<StoredArtifact> { const [rawBytes, raw] = await Promise.all([readFile(this.dataPath(sha256)), readFile(this.metadataPath(sha256), "utf8")]); const bytes = new Uint8Array(rawBytes); const metadata = ArtifactMetadata.parse(JSON.parse(raw) as unknown); if (digest(bytes) !== metadata.sha256 || metadata.uri !== this.uri(sha256)) throw new Error("VERIFICATION_FAILED: artifact integrity check failed"); return { bytes, metadata }; }
  async has(sha256: string): Promise<boolean> { try { await stat(this.dataPath(sha256)); await stat(this.metadataPath(sha256)); return true; } catch { return false; } }
  async resolve(uri: string): Promise<StoredArtifact> { const match = /^artifact:\/\/sha256-([a-f0-9]{64})$/.exec(uri); if (!match?.[1]) throw new Error("INVALID_ARGUMENT: invalid artifact URI"); return this.get(match[1]); }
}

export function sha256(bytes: Uint8Array): string { return digest(bytes); }
