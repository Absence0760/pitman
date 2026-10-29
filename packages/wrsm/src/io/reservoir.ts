/**
 * Reader and writer for the reservoir module file, `<net>RV<n>.DAT`
 * (TT 691 §12.3 pp.157–158; docs/formats.md §6). The same layout serves real
 * dams and lumped farm dams. RV files carry no version number.
 *
 * The writer produces the layout WRSM2000 writes, so a file it wrote reads
 * and writes back byte for byte: `L5` count and route lines (U-10), three
 * empty lines for an empty year table (D-12), and L.015 only when the file
 * had one (D-17).
 */

import type { FieldCursor } from './tokens.js';
import { ModuleLines, fixed, int, joinLines, leftInt5, minimal, monthly, quoted, readCount, readFileName, readTwelve, rightInt, routeLine, unpaddedL5 } from './module-file.js';
import type { Monthly12, ReservoirCapacity, ReservoirModule, ReservoirOutflow, RouteConnection } from '../types.js';

/** A route's defined-flow file `'*'`: a monthly defined abstraction with an L.014 line (TT 691 p.158). */
const MONTHLY_ABSTRACTION = '*';

/** Read a reservoir module file. Throws a `WrsmParseError` naming the file, line and field. */
export function readReservoir(text: string, fileName: string): ReservoirModule {
	const lines = new ModuleLines(text, fileName);

	const l1 = lines.next('L.001');
	const number = l1.integer('L.001 NRVEN');
	const name = l1.string('L.001 RVNAM');
	l1.end('L.001');

	const l2 = lines.next('L.002');
	const mapMm = l2.number('L.002 MAP');
	const rainfallFile = l2.string('L.002 rainfall file');
	const areaVolumePower = l2.number('L.002 RVPOW');
	l2.end('L.002');

	const l3 = lines.next('L.003');
	const nyr = readCount(l3, 'L.003 NYR');
	l3.end('L.003');

	// D-12: with NYR = 0 the three table lines are present and empty.
	const l4 = lines.next('L.004');
	const years = l4.numbers('L.004 year', nyr);
	l4.end('L.004');
	const l5 = lines.next('L.005');
	const volumes = l5.numbers('L.005 FSV', nyr);
	l5.end('L.005');
	const l6 = lines.next('L.006');
	const areas = l6.numbers('L.006 area', nyr);
	l6.end('L.006');
	const capacity: ReservoirCapacity[] = years.map((year, k) => ({
		year,
		fullSupplyVolumeMm3: volumes[k] as number,
		fullSupplyAreaKm2: areas[k] as number
	}));

	const panMm = readTwelve(lines.next('L.007'), 'L.007 pan evaporation');
	const panFactors = readTwelve(lines.next('L.008'), 'L.008 pan factor');

	const l9 = lines.next('L.009');
	const spillRoute = l9.integer('L.009 spill route');
	l9.end('L.009');

	const l10 = lines.next('L.010');
	const inflowCount = readCount(l10, 'L.010 inflow routes');
	l10.end('L.010');
	const inflows: RouteConnection[] = [];
	for (let k = 0; k < inflowCount; k++) inflows.push(readRoute(lines.next('L.011'), 'L.011'));

	const l12 = lines.next('L.012');
	const outflowCount = readCount(l12, 'L.012 outflow routes');
	l12.end('L.012');
	const outflows: ReservoirOutflow[] = [];
	for (let k = 0; k < outflowCount; k++) {
		const route = readRoute(lines.next('L.013'), 'L.013');
		if (route.definedFlowFile !== MONTHLY_ABSTRACTION) {
			outflows.push(route);
			continue;
		}
		// U-8: L.014 is taken to follow its own L.013 line (the manual's example numbering).
		const l14 = lines.next('L.014');
		const values = l14.numbers('L.014', 14);
		l14.end('L.014');
		outflows.push({
			...route,
			monthlyAbstraction: {
				volumesMm3: values.slice(0, 12) as unknown as Monthly12,
				fullSupplyAboveMm3: values[12] as number,
				restrictionFactor: values[13] as number
			}
		});
	}

	// L.015 is optional and, when present, the last line (TT 691 p.158).
	let initialStorageMm3: number | undefined;
	if (!lines.atEnd) {
		const l15 = lines.next('L.015');
		initialStorageMm3 = l15.number('L.015 initial storage');
		l15.end('L.015');
	}
	if (!lines.atEnd) throw lines.error('unexpected line after the last reservoir line type (L.015)');

	return {
		kind: 'RV',
		number,
		name,
		mapMm,
		rainfallFile,
		areaVolumePower,
		capacity,
		panMm,
		panFactors,
		spillRoute,
		inflows,
		outflows,
		...(initialStorageMm3 !== undefined && { initialStorageMm3 }),
		...(unpaddedL5([l9, l10, l12]) && { unpaddedRouteLines: true })
	};
}

function readRoute(cursor: FieldCursor, lineType: string): RouteConnection {
	const route = cursor.integer(`${lineType} route`);
	const definedFlowFile = readFileName(cursor, `${lineType} defined-flow file`);
	cursor.end(lineType);
	return { route, definedFlowFile };
}

/** Write a reservoir module file in WRSM2000's own layout (docs/formats.md §6), CRLF line endings. */
export function writeReservoir(m: ReservoirModule): string {
	const out: string[] = [];
	out.push(`${int(m.number, 'L.001 NRVEN')} ${quoted(m.name, 'L.001 RVNAM')}`);
	out.push(
		`${fixed(m.mapMm, 7, 0, 'L.002 MAP')} ${quoted(m.rainfallFile, 'L.002 rainfall file')}  ${fixed(m.areaVolumePower, 6, 4, 'L.002 RVPOW')}`
	);
	out.push(rightInt(m.capacity.length, 4, 'L.003 NYR'));
	// D-12: NYR(1X,…) of an empty table is an empty line.
	out.push(m.capacity.map((c) => ` ${rightInt(c.year, 4, 'L.004 year')}`).join(''));
	out.push(m.capacity.map((c) => ` ${minimal(c.fullSupplyVolumeMm3, 2, 'L.005 FSV')}`).join(''));
	out.push(m.capacity.map((c) => ` ${minimal(c.fullSupplyAreaKm2, 2, 'L.006 area')}`).join(''));
	out.push(monthly(m.panMm, 2, 'L.007 pan evaporation'));
	out.push(monthly(m.panFactors, 4, 'L.008 pan factor'));
	const unpadded = m.unpaddedRouteLines === true;
	out.push(leftInt5(m.spillRoute, 'L.009 spill route', unpadded));
	out.push(leftInt5(m.inflows.length, 'L.010 inflow routes', unpadded));
	for (const r of m.inflows) out.push(routeLine(r.route, r.definedFlowFile, 'L.011'));
	out.push(leftInt5(m.outflows.length, 'L.012 outflow routes', unpadded));
	for (const r of m.outflows) {
		const a = r.monthlyAbstraction;
		if (a === undefined) {
			out.push(routeLine(r.route, r.definedFlowFile, 'L.013'));
			continue;
		}
		// Never observed (docs/formats.md §6): free format, single-spaced, 3 decimals (U-8).
		out.push(routeLine(r.route, MONTHLY_ABSTRACTION, 'L.013'));
		out.push([...a.volumesMm3, a.fullSupplyAboveMm3, a.restrictionFactor].map((v) => minimal(v, 3, 'L.014')).join(' '));
	}
	if (m.initialStorageMm3 !== undefined) out.push(fixed(m.initialStorageMm3, 8, 3, 'L.015 initial storage'));
	return joinLines(out);
}

