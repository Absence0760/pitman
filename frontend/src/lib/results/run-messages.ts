/**
 * What the engine said about a run, for a hydrologist to read. A dry reservoir
 * reports every month, so a real network gives hundreds of lines that say one
 * thing: they are grouped by level, module and wording, across the modes run.
 */
import { moduleLabel, type RunMessage, type RunResult } from '@pitman/wrsm';
import { hydroYearLabel, runLabel } from './format.js';

export interface MessageGroup {
	readonly level: RunMessage['level'];
	/** `RV 3`, or `''` for a message about the whole network. */
	readonly module: string;
	/** The first message of the group, as the engine wrote it. */
	readonly text: string;
	/** How often it occurs in one run, the most of any mode: two modes saying one thing aren't two months. */
	readonly count: number;
	readonly modes: readonly string[];
	/** Hydrological years of the first and last dated messages. */
	readonly firstYear?: number;
	readonly lastYear?: number;
}

const LEVELS: readonly RunMessage['level'][] = ['error', 'warning', 'info'];

/** The wording without its month and numbers, so the same complaint in two months is one group. */
function wording(text: string): string {
	return text.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}\b/g, '').replace(/-?\d+(\.\d+)?/g, '#');
}

/** Every run's messages grouped, errors first, then warnings, then notes, in the order the engine met them. */
export function groupRunMessages(runs: readonly RunResult[]): MessageGroup[] {
	const groups = new Map<string, { level: RunMessage['level']; module: string; text: string; counts: Map<string, number>; firstYear?: number; lastYear?: number }>();
	for (const run of runs) {
		const mode = runLabel(run.mode);
		for (const m of run.messages) {
			const module = m.module ? moduleLabel(m.module) : '';
			const key = `${m.level}|${module}|${m.route ?? ''}|${wording(m.text)}`;
			let group = groups.get(key);
			if (!group) groups.set(key, (group = { level: m.level, module: m.text.startsWith(module) ? '' : module, text: m.text, counts: new Map() }));
			group.counts.set(mode, (group.counts.get(mode) ?? 0) + 1);
			if (m.at) {
				group.firstYear = Math.min(group.firstYear ?? m.at.year, m.at.year);
				group.lastYear = Math.max(group.lastYear ?? m.at.year, m.at.year);
			}
		}
	}
	return LEVELS.flatMap((level) => [...groups.values()].filter((g) => g.level === level)).map(({ counts, ...g }) => ({ ...g, count: Math.max(...counts.values()), modes: [...counts.keys()] }));
}

/** `in 304 months, 1920/21 to 2008/09`, or `''` for a message that occurs once. */
export function groupSpan(group: MessageGroup): string {
	if (group.count < 2) return '';
	if (group.firstYear === undefined || group.lastYear === undefined) return `${group.count} times`;
	const years = group.firstYear === group.lastYear ? hydroYearLabel(group.firstYear) : `${hydroYearLabel(group.firstYear)} to ${hydroYearLabel(group.lastYear)}`;
	return `in ${group.count} months, ${years}`;
}

/** `2 errors and 5 warnings`, counted in groups, or `''` when nothing needs reading. */
export function messageSummary(groups: readonly MessageGroup[]): string {
	const say = (n: number, word: string) => (n === 0 ? '' : `${n} ${word}${n === 1 ? '' : 's'}`);
	const parts = [say(groups.filter((g) => g.level === 'error').length, 'error'), say(groups.filter((g) => g.level === 'warning').length, 'warning')].filter(Boolean);
	return parts.join(' and ');
}
