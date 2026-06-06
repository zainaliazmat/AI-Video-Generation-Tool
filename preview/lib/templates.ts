import {readdirSync, existsSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

/**
 * Server-only: enumerate the template catalog for the gallery by reading the
 * manifests directly (NOT importing the registry — that would pull every
 * Remotion component into the page bundle). Preview asset URLs are included only
 * when the generated files exist, so the gallery degrades gracefully when
 * `gen-previews` hasn't run.
 */
export type TemplateMeta = {
  id: string;
  name: string;
  kind: string;
  version: string;
  author: string;
  apiVersion: string;
  durationFrames: {min: number; max: number};
  sampleProps: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  mp4: string | null; // public URL, or null if not generated yet
  poster: string | null;
};

// Slot display order (mirrors the TemplateKind set).
const KIND_ORDER = ['hook', 'scene', 'stat', 'lower-third', 'transition', 'overlay', 'outro'];

export function loadTemplates(): TemplateMeta[] {
  const templatesDir = resolve(process.cwd(), '..', 'templates');
  const previewsDir = resolve(process.cwd(), 'public', 'previews');
  const out: TemplateMeta[] = [];

  for (const entry of readdirSync(templatesDir, {withFileTypes: true})) {
    if (!entry.isDirectory() || entry.name === 'scripts' || entry.name === 'node_modules') continue;
    const manifestPath = join(templatesDir, entry.name, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    out.push({
      id: m.id,
      name: m.name,
      kind: m.kind,
      version: m.version,
      author: m.author,
      apiVersion: m.apiVersion,
      durationFrames: m.durationFrames,
      sampleProps: m.sampleProps ?? {},
      inputSchema: m.inputSchema ?? {},
      mp4: existsSync(join(previewsDir, `${m.id}.mp4`)) ? `/previews/${m.id}.mp4` : null,
      poster: existsSync(join(previewsDir, `${m.id}.jpg`)) ? `/previews/${m.id}.jpg` : null,
    });
  }

  out.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.id.localeCompare(b.id),
  );
  return out;
}
