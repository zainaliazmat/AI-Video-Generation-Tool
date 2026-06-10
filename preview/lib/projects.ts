// preview/lib/projects.ts
import path from 'node:path';

export type ProjectMeta = {
  id: string;
  topic: string;
  title: string;
  createdAt: number;
  durationInFrames: number;
  fps: number;
  hasRender: boolean; // derived from projects/<id>/video.mp4 existence
};

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
