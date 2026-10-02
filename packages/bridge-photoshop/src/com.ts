import { spawn } from "node:child_process";

export interface ComRequest {
  operation: "inspect" | "mutate" | "export";
  target?: unknown;
  commands?: readonly Record<string, unknown>[];
  path?: string;
  format?: string;
}

export interface ComResponse {
  data?: unknown;
  revision?: string;
  artifact?: { displayName: string; sizeBytes?: number; mediaType?: string };
}

export interface PhotoshopComFallback {
  inspect(target: unknown): Promise<{ revision: string; data: Record<string, unknown> }>;
  mutate(target: unknown, commands: readonly Record<string, unknown>[]): Promise<{ revision: string; appliedIndexes: number[]; failedIndexes: number[]; tempIdMap: Record<string, string> }>;
  export(target: unknown, path: string, format: string, options: Record<string, unknown>): Promise<ComResponse>;
  close(): Promise<void>;
}

/**
 * The COM worker is deliberately a fixed PowerShell program. User input is
 * sent as JSON data over stdin and is never interpolated into PowerShell.
 * This keeps the fallback useful on Windows without reintroducing eval or a
 * general-purpose scripting bridge.
 */
export class WindowsPhotoshopCom implements PhotoshopComFallback {
  private readonly timeoutMs: number;

  constructor(timeoutMs = 30_000) {
    this.timeoutMs = timeoutMs;
  }

  async inspect(target: unknown): Promise<{ revision: string; data: Record<string, unknown> }> {
    const result = await this.run({ operation: "inspect", target });
    return { revision: result.revision ?? `com-${Date.now()}`, data: (result.data ?? {}) as Record<string, unknown> };
  }

  async mutate(target: unknown, commands: readonly Record<string, unknown>[]): Promise<{ revision: string; appliedIndexes: number[]; failedIndexes: number[]; tempIdMap: Record<string, string> }> {
    const result = await this.run({ operation: "mutate", target, commands });
    return {
      revision: result.revision ?? `com-${Date.now()}`,
      appliedIndexes: Array.isArray(result.data) ? result.data as number[] : [],
      failedIndexes: [],
      tempIdMap: {},
    };
  }

  async export(target: unknown, path: string, format: string, options: Record<string, unknown>): Promise<ComResponse> {
    return this.run({ operation: "export", target, path, format, commands: [options] });
  }

  async close(): Promise<void> {
    // COM is created per request so the worker cannot retain Photoshop COM
    // objects after the bridge is closed.
  }

  private run(request: ComRequest): Promise<ComResponse> {
    if (process.platform !== "win32") return Promise.reject(new Error("UNSUPPORTED_CAPABILITY: Photoshop COM is Windows-only"));

    return new Promise((resolve, reject) => {
      const encoded = Buffer.from(POWERSHELL_WORKER, "utf16le").toString("base64");
      const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("TIMEOUT: Photoshop COM worker timed out")); }, this.timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", (error) => { clearTimeout(timer); reject(new Error(`HOST_ERROR: ${error.message}`)); });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) { reject(new Error(`HOST_ERROR: ${stderr.trim() || `COM worker exited with ${code ?? "unknown"}`}`)); return; }
        try { resolve(JSON.parse(stdout.trim()) as ComResponse); } catch { reject(new Error("HOST_ERROR: invalid response from Photoshop COM worker")); }
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}

const POWERSHELL_WORKER = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$app = New-Object -ComObject Photoshop.Application
$doc = $app.ActiveDocument
if ($null -eq $doc) { throw 'No active Photoshop document' }
$revision = 'com-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

function Get-Layers($collection, $parent, $prefix) {
  $items = @()
  for ($i = 1; $i -le $collection.Count; $i++) {
    $layer = $collection.Item($i)
    $id = 'com-layer-' + $prefix + '-' + $i
    $kind = if ($layer.typename -eq 'LayerSet') { 'group' } elseif ($layer.Kind -eq 2) { 'text' } else { 'pixel' }
    $bounds = @{ x = [double]$layer.Bounds[0]; y = [double]$layer.Bounds[1]; width = [double]$layer.Bounds[2] - [double]$layer.Bounds[0]; height = [double]$layer.Bounds[3] - [double]$layer.Bounds[1]; unit = 'px' }
    $items += @{ id=$id; name=[string]$layer.Name; kind=$kind; parentId=$parent; visible=[bool]$layer.Visible; locked=$false; opacity=([double]$layer.Opacity / 100); blendMode=[string]$layer.BlendMode; bounds=$bounds; selected=$false }
    if ($layer.typename -eq 'LayerSet') { $items += Get-Layers $layer.Layers $id ($prefix + '-' + $i) }
  }
  return $items
}

if ($request.operation -eq 'inspect') {
  $layers = @(Get-Layers $doc.Layers $null 'root')
  $data = @{ id='com-document-1'; revision=$revision; name=[string]$doc.Name; saved=$true; width=[double]$doc.Width; height=[double]$doc.Height; unit='px'; resolutionPpi=[double]$doc.Resolution; mode='rgb'; bitDepth=8; activeLayerIds=@(); layers=$layers; truncated=$false }
  @{ revision=$revision; data=$data } | ConvertTo-Json -Compress -Depth 32
  exit 0
}

if ($request.operation -eq 'mutate') {
  $applied = @()
  $index = 0
  foreach ($command in @($request.commands)) {
    switch ([string]$command.op) {
      'set' {
        foreach ($layer in @(Get-Layers $doc.Layers $null 'root')) {
          if ($layer.id -eq $command.layerId) { break }
        }
        # COM collections do not expose a stable public id. Name/visibility
        # changes are therefore intentionally limited to the active layer.
        $active = $doc.ActiveLayer
        if ($null -ne $command.patch.name) { $active.Name = [string]$command.patch.name }
        if ($null -ne $command.patch.visible) { $active.Visible = [bool]$command.patch.visible }
        if ($null -ne $command.patch.opacity) { $active.Opacity = [double]$command.patch.opacity * 100 }
        $applied += $index
      }
      'delete' { $doc.ActiveLayer.Delete(); $applied += $index }
      'create' { if ([string]$command.kind -eq 'group') { $new = $doc.LayerSets.Add() } else { $new = $doc.ArtLayers.Add() }; $new.Name = [string]$command.name; $applied += $index }
      default { throw ('Unsupported COM layer operation: ' + [string]$command.op) }
    }
    $index++
  }
  @{ revision=$revision; data=$applied } | ConvertTo-Json -Compress -Depth 8
  exit 0
}

if ($request.operation -eq 'export') {
  $saveOptions = New-Object -ComObject Photoshop.ExportOptionsSaveForWeb
  $saveOptions.Format = 6
  $doc.Export([string]$request.path, 2, $saveOptions)
  @{ revision=$revision; artifact=@{ displayName=[IO.Path]::GetFileName([string]$request.path); mediaType='image/' + [string]$request.format } } | ConvertTo-Json -Compress -Depth 8
  exit 0
}
throw 'Unsupported COM operation'
`;

export function createWindowsPhotoshopCom(): PhotoshopComFallback {
  return new WindowsPhotoshopCom();
}
