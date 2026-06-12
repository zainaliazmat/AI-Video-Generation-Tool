import React from 'react';
import {AbsoluteFill, Img} from 'remotion';

// Asset-bearing render proof (§15.14): the <Img> below makes the preview render
// FAIL if the declared asset was not shipped+resolved (Remotion errors on 404).
const Component: React.FC<{
  data: {label?: string};
  theme: {palette: {background: string; foreground: string; accent: string}};
  timing: {fps: number; durationInFrames: number};
  assets: Record<string, string>;
}> = ({data, theme, assets}) => (
  <AbsoluteFill style={{backgroundColor: theme.palette.background, alignItems: 'center', justifyContent: 'center'}}>
    {assets['assets/dot.png'] ? (
      <Img src={assets['assets/dot.png']} style={{width: 400, height: 400, imageRendering: 'pixelated'}} />
    ) : (
      <div style={{color: theme.palette.accent, fontSize: 80, fontFamily: 'monospace'}}>NO-ASSET</div>
    )}
    <div style={{color: theme.palette.foreground, fontSize: 64, fontFamily: 'monospace'}}>{data.label ?? ''}</div>
  </AbsoluteFill>
);
export default Component;
