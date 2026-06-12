import React from 'react';
import {AbsoluteFill} from 'remotion';
import _ from 'lodash'; // DISALLOWED — outside the frozen import surface (§15.6)
const Component: React.FC<{theme: {palette: {background: string}}}> = ({theme}) => (
  <AbsoluteFill style={{backgroundColor: theme.palette.background}}>{String(_)}</AbsoluteFill>
);
export default Component;
