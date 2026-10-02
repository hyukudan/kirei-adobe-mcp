import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
if (manifest.manifestVersion !== 5) throw new Error("Photoshop UXP manifest must use version 5");
if (manifest.requiredPermissions?.localFileSystem !== "fullAccess") throw new Error("Photoshop UXP requires filesystem access");
if (!manifest.requiredPermissions?.network?.domains?.includes("ws://127.0.0.1:*")) throw new Error("Photoshop UXP must allow loopback WebSocket");
for (const file of ["index.html", "index.js"]) await readFile(resolve(root, file));
console.log("photoshop-uxp bundle validated");
