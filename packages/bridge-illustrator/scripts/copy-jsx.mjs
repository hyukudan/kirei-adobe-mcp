import { cp, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/jsx/", import.meta.url), { recursive: true });
await cp(new URL("../src/jsx/", import.meta.url), new URL("../dist/jsx/", import.meta.url), { recursive: true });
