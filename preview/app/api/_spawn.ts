import {spawn} from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(process.cwd(), '..');
const PYTHON = path.join(REPO_ROOT, 'backend', '.venv', 'bin', 'python');

// Spawn a backend Python CLI that prints exactly one JSON line on stdout, and resolve
// it. Matches the /api/generate spawn pattern (cwd = repo root so .env + paths resolve).
// Rejects on spawn error, non-zero exit, or unparseable stdout.
export function spawnJson(
  scriptRelToBackend: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{code: number; json: any}> {
  return new Promise((resolve, reject) => {
    const script = path.join(REPO_ROOT, 'backend', scriptRelToBackend);
    const child = spawn(PYTHON, [script, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
      shell: false,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${scriptRelToBackend} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (b) => (out += b.toString()));
    child.stderr.on('data', (b) => (err = (err + b.toString()).slice(-2000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.trim().split('\n').filter(Boolean).pop() ?? '';
      let json: any;
      try {
        json = JSON.parse(line);
      } catch {
        reject(new Error(`${scriptRelToBackend} bad output (exit ${code}): ${err.slice(-300)}`));
        return;
      }
      resolve({code: code ?? 0, json});
    });
  });
}
