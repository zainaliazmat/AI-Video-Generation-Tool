import AdmZip from 'adm-zip';
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';

/** Zip a fixture dir as <topName>/<files…>; mutateManifest lets a test patch the manifest. */
export function zipFixture(srcDir, {topName, mutateManifest, extraEntries = []} = {}) {
  const zip = new AdmZip();
  const top = topName ?? JSON.parse(readFileSync(join(srcDir, 'manifest.json'), 'utf8')).id;
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, {withFileTypes: true})) {
      const p = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.name === 'manifest.json' && r === 'manifest.json' && mutateManifest) {
        const m = mutateManifest(JSON.parse(readFileSync(p, 'utf8')));
        zip.addFile(`${top}/${r}`, Buffer.from(JSON.stringify(m, null, 2) + '\n'));
      } else zip.addFile(`${top}/${r}`, readFileSync(p));
    }
  };
  walk(srcDir, '');
  for (const [name, content] of extraEntries) zip.addFile(name, Buffer.from(content));
  const out = join(mkdtempSync(join(tmpdir(), 'fixzip-')), `${top}.zip`);
  zip.writeZip(out);
  return out;
}

/**
 * Create a zip with pathological entry names (e.g. '..') that AdmZip would
 * normalize away at write time.  Uses Python's zipfile module which preserves
 * the raw entry names as specified.
 *
 * @param {Array<[string, string]>} entries  Array of [entryName, content] pairs.
 * @returns {string}  Path to the written zip file.
 */
export function zipRaw(entries) {
  const script = [
    'import zipfile, io, sys',
    'import base64',
    'buf = io.BytesIO()',
    'with zipfile.ZipFile(buf, "w") as z:',
    ...entries.map(([name, content]) =>
      `    z.writestr(${JSON.stringify(name)}, base64.b64decode(${JSON.stringify(Buffer.from(content).toString('base64'))}).decode('utf-8', errors='replace'))`,
    ),
    'buf.seek(0)',
    'sys.stdout.buffer.write(buf.read())',
  ].join('\n');
  const zipBytes = execFileSync('python3', ['-c', script]);
  const out = join(mkdtempSync(join(tmpdir(), 'fixzip-')), 'raw.zip');
  writeFileSync(out, zipBytes);
  return out;
}
