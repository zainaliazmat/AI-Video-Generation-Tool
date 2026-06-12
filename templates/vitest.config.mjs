import {defineConfig} from 'vitest/config';
// The install suite mutates the REAL templates/ tree (the engine's domain is
// the repo itself) — never run test files in parallel.
export default defineConfig({test: {fileParallelism: false, testTimeout: 120_000, hookTimeout: 120_000}});
