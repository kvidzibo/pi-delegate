import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd, encoding: 'utf8' }));
const files = new Set(pack.files.map(file => file.path));
const allowed = /^(?:package\.json|README\.md|LICENSE|delegate\/[^/]+\.(?:ts|json|md)|delegate\/prompts\/[^/]+\.md|child-runtime\/[^/]+\.(?:ts|md))$/;
for (const path of files) assert.ok(allowed.test(path), `Unexpected published file: ${path}`);
const required = ['package.json', 'README.md', 'LICENSE'];
for (const dir of ['delegate', 'child-runtime']) {
  for (const entry of readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:ts|json|md)$/.test(entry.name)) required.push(`${dir}/${entry.name}`);
  }
}
for (const name of readdirSync(new URL('../delegate/prompts/', import.meta.url))) required.push(`delegate/prompts/${name}`);
for (const path of required) assert.ok(files.has(path), `Missing published runtime file: ${path}`);
console.log(`npm package: ${files.size} runtime/documentation files; no tests, benchmarks, evals or results.`);
