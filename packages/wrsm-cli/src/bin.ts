#!/usr/bin/env -S tsx
import { main } from './main.js';
import { wrsmEngine } from './wrsm-engine.js';

process.exitCode = await main(
	process.argv.slice(2),
	{
		out: (text) => process.stdout.write(text),
		err: (text) => process.stderr.write(text)
	},
	wrsmEngine
);
