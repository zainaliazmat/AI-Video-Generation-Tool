import {registerRoot} from 'remotion';
import {RemotionRoot} from './Root';

// Entry point Remotion's studio / render / bundle resolve. Must do nothing but
// register the root.
registerRoot(RemotionRoot);
