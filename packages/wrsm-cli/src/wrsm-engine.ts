import { answerFromSeries, readAnswer, readBundle, run, writeAnswer } from '@pitman/wrsm';
import type { Engine } from './engine.js';

/** The real engine: `@pitman/wrsm`'s bundle reader, network run and answer files. */
export const wrsmEngine: Engine = { readBundle, run, readAnswer, writeAnswer, answerFromSeries };
