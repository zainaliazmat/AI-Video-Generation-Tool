// preview/lib/projects.ts
import path from 'node:path';

export type ProjectMeta = {
  id: string;
  topic: string;
  /** Optional: absent on stub metas written at run-start (M1 amendment).
   *  A stub is a session that was started but hasn't completed script generation
   *  yet (or failed before it could write a full meta). */
  title?: string;
  createdAt: number;
  /** Optional / 0 on stub metas: durationInFrames is only present after the
   *  spec.json is written.  0 is also treated as "not yet known". */
  durationInFrames?: number;
  /** Optional: absent on stub metas that haven't produced audio/video yet. */
  fps?: number;
  hasRender: boolean; // derived from projects/<id>/video.mp4 existence
};

/**
 * Discriminate stub vs finished project metas.
 *
 * A stub is a project that was started but hasn't completed yet:
 *   - no title (absent or empty string), OR
 *   - durationInFrames is 0 or absent (spec.json not yet written)
 *
 * Finished projects have a non-empty title and durationInFrames > 0.
 */
export type StubKind = 'building' | 'failed' | 'finished';

export function discriminateStub(meta: ProjectMeta): StubKind {
  const hasTitle = typeof meta.title === 'string' && meta.title.trim().length > 0;
  const hasDuration = typeof meta.durationInFrames === 'number' && meta.durationInFrames > 0;
  if (hasTitle && hasDuration) return 'finished';
  // A stub without a title is either actively building or has failed/abandoned.
  // We can't distinguish building from failed from the meta alone (no status field),
  // so we use a heuristic: if the meta is very recent (< 5 min) treat as building,
  // otherwise as failed. This is best-effort — the real discriminator would be a
  // running status field from the backend.
  const ageMs = Date.now() - meta.createdAt;
  const BUILDING_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
  if (ageMs < BUILDING_THRESHOLD_MS) return 'building';
  return 'failed';
}

// The id is the backend session id (e.g. "auto-<uuid>"). We don't pin its exact
// shape (it may evolve), but we MUST reject anything that could escape the
// projects/ dir when used in a filesystem path. Allow only url/path-safe chars.
const ID_RE = /^[A-Za-z0-9_-]+$/;

export function isValidProjectId(id: string): boolean {
  return ID_RE.test(id);
}

// The preview dev server's cwd is preview/; the repo root is its parent.
export function repoRoot(): string {
  return path.resolve(process.cwd(), '..');
}

export function projectsDir(): string {
  return path.join(repoRoot(), 'projects');
}

export function projectDir(id: string): string {
  return path.join(projectsDir(), id);
}
