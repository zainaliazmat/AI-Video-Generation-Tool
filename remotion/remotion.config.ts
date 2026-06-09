import path from 'node:path';
import {Config} from '@remotion/cli/config';

// 4.0.x: Config comes from "@remotion/cli/config" (NOT "remotion"), and
// setImageFormat was replaced by setVideoImageFormat.
Config.setVideoImageFormat('jpeg');

// Dedupe react/react-dom/remotion to THIS package's single copy. The top-level
// templates/ components live OUTSIDE remotion/ and have no node_modules of their
// own, so their bare `remotion`/`react` imports must resolve here — and pinning
// to one copy prevents the "two copies of Remotion / multiple React" failure.
// studio/render/bundle all run with cwd = remotion/, so process.cwd() is right.
// Alias ONLY the bare packages (NOT @remotion/* subpaths, which would break
// their package `exports`, e.g. @remotion/google-fonts/Inter).
Config.overrideWebpackConfig((config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    alias: {
      ...(config.resolve?.alias ?? {}),
      react: path.resolve(process.cwd(), 'node_modules/react'),
      'react-dom': path.resolve(process.cwd(), 'node_modules/react-dom'),
      remotion: path.resolve(process.cwd(), 'node_modules/remotion'),
      // lucide-react: third-party dep imported by templates/enumeration (Tier 2).
      // Like react/remotion above, templates/ has no node_modules, so the bundler
      // must resolve it here in remotion/node_modules (where it is installed).
      'lucide-react': path.resolve(process.cwd(), 'node_modules/lucide-react'),
    },
  },
}));
// CPU-only box: keep parallelism modest to avoid thrash/OOM. CLI --concurrency overrides.
Config.setConcurrency(2);
// Give slow CPU video/font decoding room before delayRender() times out.
Config.setDelayRenderTimeoutInMilliseconds(120000);
Config.setOverwriteOutput(true);
