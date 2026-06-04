import type {NextConfig} from 'next';
import path from 'node:path';

const dep = (p: string) => path.resolve(__dirname, 'node_modules', p);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Remotion ships untranspiled ESM/TS; Next must process it (also covers the
  // cross-dir ../remotion/src composition import).
  transpilePackages: ['remotion', '@remotion/player', '@remotion/google-fonts'],
  // This app sits in a multi-package repo (sibling to remotion/ and backend/);
  // point file tracing at the repo root so the sibling import resolves cleanly.
  outputFileTracingRoot: path.join(__dirname, '..'),
  webpack: (config) => {
    // CRITICAL dedupe: the composition lives in ../remotion/src and imports
    // `remotion`, which node-resolves to remotion/node_modules/remotion — a
    // SECOND copy from the Player's preview/node_modules/remotion. Two copies =
    // two React contexts, so useVideoConfig() throws "No video config found /
    // multiple versions of Remotion". Force every Remotion + React import to
    // this app's single copy.
    // Alias ONLY `remotion` (the package that holds the React context). Next
    // already dedupes React for the app, and aliasing the @remotion/* subpath
    // packages to a raw dir breaks their package `exports` (e.g.
    // @remotion/google-fonts/Inter). Forcing the bare `remotion` to one copy
    // also redirects the internal `import 'remotion'` inside @remotion/player
    // and @remotion/google-fonts, collapsing everything to a single instance.
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      remotion: dep('remotion'),
    };
    return config;
  },
};

export default nextConfig;
