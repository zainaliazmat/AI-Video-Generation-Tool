// preview/lib/projects-server.ts
// SERVER-ONLY: filesystem path helpers (uses node:path). Import this ONLY from
// API route handlers — never from a client component (it would pull node:path
// into the browser bundle). Client-safe types/helpers live in lib/projects.ts.
import path from 'node:path';

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
