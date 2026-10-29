#!/usr/bin/env -S tsx
import { main } from './main.js';

// TODO(integration): pass the real engine as the third argument, a plain
// object of @pitman/wrsm exports matching `Engine` (engine.ts): readNetwork,
// readRunoff, readRainfall, readAnswer, writeAnswer, answerFromSeries,
// runRunoffModule. Until then `run` and `compare` exit 2 "not implemented yet".
process.exitCode = await main(process.argv.slice(2), {
	out: (text) => process.stdout.write(text),
	err: (text) => process.stderr.write(text)
});
