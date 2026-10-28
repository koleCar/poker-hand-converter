// Remotion's entry point (`remotion studio src/index.ts`).

// Rail's own design tokens - the shared UI package's sheets, not a copy.
import '../../packages/ui/tokens/primitives.css';
import '../../packages/ui/tokens/semantic.css';
import '../../packages/ui/tokens/motion.css';
import './global.css';

import { registerRoot } from 'remotion';

import { RemotionRoot } from './Root';

registerRoot(RemotionRoot);
