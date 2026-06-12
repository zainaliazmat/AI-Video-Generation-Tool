// zod → JSON Schema codegen (the input-schema bridge, phase-2 prompt §2).
//
// Each content template authors its input contract once as a zod `schema` in
// <id>/schema.ts (the single source of truth). This script exports that schema
// to the template's manifest.json `inputSchema` (JSON Schema) so the Python
// backend can validate specs against it. Runs via tsx (it imports .ts).
//
// Idempotent: only the `inputSchema` field is rewritten; every other manifest
// field (and key order) is preserved. Templates without a schema.ts (e.g.
// `transition` kinds, which ship a presentation.tsx) keep their hand-authored
// inputSchema and are skipped.
import {readdirSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {zodToJsonSchema} from 'zod-to-json-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dirFlag = process.argv.indexOf('--dir');
const templatesDir = dirFlag !== -1 && process.argv[dirFlag + 1]
  ? resolve(process.argv[dirFlag + 1])
  : resolve(__dirname, '..');

function entryFile(dir: string): string | null {
  for (const f of ['schema.ts', 'schema.js']) {
    const p = join(dir, f);
    if (existsSync(p)) return p;
  }
  return null;
}

async function run() {
  const done: string[] = [];
  for (const entry of readdirSync(templatesDir, {withFileTypes: true})) {
    if (!entry.isDirectory() || entry.name === 'scripts' || entry.name === 'node_modules') continue;
    if (entry.name.startsWith('.')) continue; // §17.4: staging/dot dirs are never templates
    const dir = join(templatesDir, entry.name);
    if (existsSync(join(dir, '.installing'))) continue; // §15.2: mid-install folder, skip
    const manifestPath = join(dir, 'manifest.json');
    const schemaPath = entryFile(dir);
    if (!existsSync(manifestPath) || !schemaPath) continue; // no manifest or no zod schema → skip

    const mod = await import(pathToFileURL(schemaPath).href);
    if (!mod.schema) {
      throw new Error(`[gen-manifests] ${entry.name}/schema.ts must export a zod \`schema\``);
    }

    const jsonSchema = zodToJsonSchema(mod.schema, {target: 'jsonSchema7', $refStrategy: 'none'}) as Record<string, unknown>;
    delete jsonSchema.$schema; // inline schema, no meta header

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.inputSchema = jsonSchema; // replace in place → key order preserved
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    done.push(manifest.id ?? entry.name);
  }
  done.sort();
  console.log(`[gen-manifests] ${done.length} manifest(s) regenerated from zod: ${done.join(', ') || '(none)'}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
