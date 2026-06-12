import React from 'react';
const Component: React.FC = () => {
  const n: number = 'not a number'; // TS2322 — the stage-6 gate must catch this
  return <div>{n}</div>;
};
export default Component;
