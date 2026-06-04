import {Config} from '@remotion/cli/config';

// 4.0.x: Config comes from "@remotion/cli/config" (NOT "remotion"), and
// setImageFormat was replaced by setVideoImageFormat.
Config.setVideoImageFormat('jpeg');
// CPU-only box: keep parallelism modest to avoid thrash/OOM. CLI --concurrency overrides.
Config.setConcurrency(2);
// Give slow CPU video/font decoding room before delayRender() times out.
Config.setDelayRenderTimeoutInMilliseconds(120000);
Config.setOverwriteOutput(true);
