// preview/app/api/projects/route.ts
import {readdirSync, readFileSync, existsSync} from 'node:fs';
import path from 'node:path';
import {projectsDir, projectDir, type ProjectMeta} from '@/lib/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const dir = projectsDir();
  const out: ProjectMeta[] = [];
  if (existsSync(dir)) {
    for (const id of readdirSync(dir)) {
      const metaPath = path.join(projectDir(id), 'meta.json');
      if (!existsSync(metaPath)) continue; // skip incomplete/foreign folders
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        out.push({
          ...meta,
          hasRender: existsSync(path.join(projectDir(id), 'video.mp4')),
        });
      } catch {
        // ignore a malformed meta.json — never let one bad folder break the list
      }
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt); // newest first
  return Response.json(out);
}
