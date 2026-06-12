import {readdirSync, existsSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

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
  // Extended fields (Task 2 — §16.2/§16.6)
  description?: string;
  tags?: string[];
  license?: string;
  /** True when `git status --porcelain templates/<id>` is non-empty (§16.11). */
  uncommitted?: boolean;
};

// Slot display order (mirrors the TemplateKind set).
const KIND_ORDER = ['hook', 'scene', 'stat', 'lower-third', 'transition', 'overlay', 'outro'];

export function loadTemplates(): TemplateMeta[] {
  const templatesDir = resolve(process.cwd(), '..', 'templates');
  const previewsDir = resolve(process.cwd(), 'public', 'previews');
  const repoRoot = resolve(process.cwd(), '..');
  const out: TemplateMeta[] = [];

  for (const entry of readdirSync(templatesDir, {withFileTypes: true})) {
    if (!entry.isDirectory() || entry.name === 'scripts' || entry.name === 'node_modules') continue;
    const manifestPath = join(templatesDir, entry.name, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));

    // §16.11: uncommitted = git status --porcelain on the template dir.
    let uncommitted = false;
    try {
      const out = execFileSync(
        'git',
        ['status', '--porcelain', '--', `templates/${entry.name}`],
        {cwd: repoRoot, encoding: 'utf8'},
      );
      uncommitted = out.trim().length > 0;
    } catch {
      uncommitted = false;
    }

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
      description: m.description,
      tags: m.tags,
      license: m.license,
      uncommitted,
    });
  }

  out.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.id.localeCompare(b.id),
  );
  return out;
}
