import {
	answerFromSeries,
	readAnswer,
	readNetwork,
	readRainfall,
	readRunoff,
	runRunoffModule,
	writeAnswer
} from '@pitman/wrsm';
import type { Engine } from './engine.js';

/** The real engine: `@pitman/wrsm`'s readers, writers and runoff module. */
export const wrsmEngine: Engine = {
	readNetwork,
	readRunoff,
	readRainfall,
	readAnswer,
	writeAnswer,
	answerFromSeries,
	runRunoffModule
};
