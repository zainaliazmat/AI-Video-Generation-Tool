import {defineConfig} from 'vitest/config';
import {resolve} from 'node:path';
export default defineConfig({
  resolve: {
    alias: {'@': resolve(__dirname, '.')},
  },
  // Use the automatic JSX runtime so component-render tests (jsdom, per-file
  // env override) don't require `React` in scope. No-op for the node-env .ts
  // suites that contain no JSX.
  esbuild: {jsx: 'automatic'},
  test: {environment: 'node'},
});
