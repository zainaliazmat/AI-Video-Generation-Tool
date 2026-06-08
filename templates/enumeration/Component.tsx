import React from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {EnumerationData} from './schema';

// Minimal placeholder so the registry import resolves; the real voice-locked
// reveal lands in Task H of the implementation plan.
const Component: React.FC<TemplateProps<EnumerationData>> = ({data, theme}) => {
  useCurrentFrame();
  return (
    <AbsoluteFill style={{backgroundColor: theme.palette.background}}>
      {data.items.map((label, i) => (
        <div key={i} style={{color: theme.palette.foreground}}>
          {label}
        </div>
      ))}
    </AbsoluteFill>
  );
};

export default Component;
