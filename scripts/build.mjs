import { build } from "esbuild";
import { chmod, cp, mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
await mkdir(new URL("../dist", import.meta.url), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: { server: "mcp/server.ts", "lease-guard": "child-runtime/lease-guard.ts" },
  outdir: "dist", bundle: true, packages: "external", platform: "node", format: "esm", target: "node22",
  define: { PACKAGE_VERSION: JSON.stringify(manifest.version) },
});
await cp(new URL("../delegate/config.json", import.meta.url), new URL("../dist/config.json", import.meta.url));
await chmod(new URL("../dist/server.js", import.meta.url), 0o755);
