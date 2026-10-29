/**
 * Reader and writer for the channel reach module file, `<net>CR<n>.DAT`
 * (TT 691 §12.2 pp.154–156; docs/formats.md §7), file version 2.
 *
 * L.012–L.017 (wetland geometry and diversion) are written by WRSM2000 for
 * every wetland type, not only the comprehensive one the manual describes
 * (D-11); the reader takes them when present, and the writer writes them
 * when the module has them. Their meaning for wetland types 1–3 is
 * unverified (U-15): every real file is type 0 with dummy values.
 */

import type { FieldCursor } from './tokens.js';
import {
	ModuleLines,
	fixed,
	int,
	joinLines,
	leftInt5,
	monthly,
	quoted,
	readCount,
	readFileName,
	readTwelve,
	rightInt,
	routeLine,
	unpaddedL5
} from './module-file.js';
import type { ChannelModule, RouteConnection, WetlandType } from '../types.js';

/** Read a channel reach file. Throws a `WrsmParseError` naming the file, line and field. */
export function readChannel(text: string, fileName: string): ChannelModule {
	const lines = new ModuleLines(text, fileName);

	const l1 = lines.next('L.001');
	const number = l1.integer('L.001 module number');
	const name = l1.string('L.001 name');
	const versionToken = l1.peek();
	const fileVersion = l1.integer('L.001 file version');
	l1.end('L.001');
	if (fileVersion !== 2) {
		throw l1.error(`channel file version ${fileVersion} is not supported (only version 2 is known)`, 'L.001 file version', versionToken);
	}

	const l2 = lines.next('L.002');
	const wetlandMapMm = l2.number('L.002 wetland MAP');
	const wetlandRainfallFile = readFileName(l2, 'L.002 wetland rainfall file');
	l2.end('L.002');

	const l3 = lines.next('L.003');
	const bedLossMm3PerMonth = l3.number('L.003 CHBL');
	const wetlandStorageMm3 = l3.number('L.003 CHC1');
	const wetlandAreaKm2 = l3.number('L.003 CHC2');
	const rechargeCoefficient = l3.number('L.003 CHC3');
	l3.end('L.003');

	const panMm = readTwelve(lines.next('L.004'), 'L.004 pan evaporation');
	const panFactors = readTwelve(lines.next('L.005'), 'L.005 pan factor');

	const l6 = lines.next('L.006');
	const principalOutflowRoute = l6.integer('L.006 principal outflow route');
	l6.end('L.006');

	const inflows = readRoutes(lines, 'L.007', 'L.008', 'inflow');
	const outflows = readRoutes(lines, 'L.009', 'L.010', 'outflow');
	const unpaddedRouteLines = unpaddedL5([l6, inflows.countLine, outflows.countLine]);

	const l11 = lines.next('L.011');
	const reserved = l11.integer('L.011 reserved');
	const typeToken = l11.peek();
	const wetlandType = l11.integer('L.011 wetland type');
	l11.end('L.011');
	if (wetlandType < 0 || wetlandType > 3) throw l11.error(`wetland type ${wetlandType} is not 0–3`, 'L.011 wetland type', typeToken);

	const module: ChannelModule = {
		kind: 'CR',
		number,
		name,
		fileVersion,
		wetlandMapMm,
		wetlandRainfallFile,
		bedLossMm3PerMonth,
		wetlandStorageMm3,
		wetlandAreaKm2,
		rechargeCoefficient,
		panMm,
		panFactors,
		principalOutflowRoute,
		inflows: inflows.routes,
		outflows: outflows.routes,
		reserved,
		wetlandType: wetlandType as WetlandType,
		...(unpaddedRouteLines && { unpaddedRouteLines })
	};
	// D-11: present in every real file; tolerate a file that stops at L.011.
	if (lines.atEnd) return module;

	const l12 = lines.next('L.012');
	const g = l12.numbers('L.012', 6) as [number, number, number, number, number, number];
	l12.end('L.012');
	const l13 = lines.next('L.013');
	const qdiv = l13.number('L.013 QDIV');
	l13.end('L.013');
	const localWetlandInflowRoute = singleInteger(lines.next('L.014'), 'L.014 local wetland inflow route');
	const localWetlandOutflowRoute = singleInteger(lines.next('L.015'), 'L.015 local wetland outflow route');
	const diversionRoute = singleInteger(lines.next('L.016'), 'L.016 diversion route');
	const l17 = lines.next('L.017');
	const d = l17.numbers('L.017', 3) as [number, number, number];
	l17.end('L.017');
	const trailingLines = lines.rest();

	return {
		...module,
		comprehensiveWetland: {
			bankfullAreaKm2: g[0],
			bankfullVolumeMm3: g[1],
			areaVolumePower: g[2],
			channelBankfullCapacity: g[3],
			excessToWetland: g[4],
			wetlandToChannel: g[5]
		},
		qdiv,
		localWetlandInflowRoute,
		localWetlandOutflowRoute,
		diversionRoute,
		diversion: { bankfullCapacity: d[0], efficiency: d[1], maxMonthlyMm3: d[2] },
		...(trailingLines.length > 0 && { trailingLines })
	};
}

function readRoutes(
	lines: ModuleLines,
	countType: string,
	routeType: string,
	what: string
): { countLine: FieldCursor; routes: RouteConnection[] } {
	const c = lines.next(countType);
	const count = readCount(c, `${countType} ${what} routes`);
	c.end(countType);
	const out: RouteConnection[] = [];
	for (let k = 0; k < count; k++) {
		const r = lines.next(routeType);
		const route = r.integer(`${routeType} route`);
		const definedFlowFile = readFileName(r, `${routeType} defined-flow file`);
		r.end(routeType);
		out.push({ route, definedFlowFile });
	}
	return { countLine: c, routes: out };
}

function singleInteger(cursor: FieldCursor, field: string): number {
	const value = cursor.integer(field);
	cursor.end(field);
	return value;
}

/** Write a channel reach file in WRSM2000's own layout (docs/formats.md §7), CRLF line endings. */
export function writeChannel(m: ChannelModule): string {
	const out: string[] = [];
	out.push(`${int(m.number, 'L.001 module number')} ${quoted(m.name, 'L.001 name')}${rightInt(m.fileVersion, 4, 'L.001 file version')}`);
	out.push(`${fixed(m.wetlandMapMm, 7, 0, 'L.002 wetland MAP')} ${quoted(m.wetlandRainfallFile ?? ' ', 'L.002 wetland rainfall file')}`);
	out.push(
		[m.bedLossMm3PerMonth, m.wetlandStorageMm3, m.wetlandAreaKm2, m.rechargeCoefficient]
			.map((v, k) => fixed(v, k === 0 ? 7 : 8, 2, `L.003[${k}]`))
			.join('')
	);
	out.push(monthly(m.panMm, 2, 'L.004 pan evaporation'));
	out.push(monthly(m.panFactors, 4, 'L.005 pan factor'));
	const unpadded = m.unpaddedRouteLines === true;
	out.push(leftInt5(m.principalOutflowRoute, 'L.006 principal outflow route', unpadded));
	out.push(leftInt5(m.inflows.length, 'L.007 inflow routes', unpadded));
	for (const r of m.inflows) out.push(routeLine(r.route, r.definedFlowFile, 'L.008'));
	out.push(leftInt5(m.outflows.length, 'L.009 outflow routes', unpadded));
	for (const r of m.outflows) out.push(routeLine(r.route, r.definedFlowFile, 'L.010'));
	out.push(`${rightInt(m.reserved, 4, 'L.011 reserved')}${rightInt(m.wetlandType, 4, 'L.011 wetland type')}`);

	// L.003, L.012 and L.017 start one column narrower than the rest
	// (F7.2,3F8.2; F9.3,5F10.3; F9.3,2F10.3), as in every real file.
	const g = m.comprehensiveWetland;
	if (g !== undefined) {
		const geometry = [g.bankfullAreaKm2, g.bankfullVolumeMm3, g.areaVolumePower, g.channelBankfullCapacity, g.excessToWetland, g.wetlandToChannel];
		out.push(geometry.map((v, k) => fixed(v, k === 0 ? 9 : 10, 3, `L.012[${k}]`)).join(''));
		out.push(fixed(m.qdiv ?? 0, 7, 3, 'L.013 QDIV'));
		out.push(rightInt(m.localWetlandInflowRoute ?? 0, 4, 'L.014 local wetland inflow route'));
		out.push(rightInt(m.localWetlandOutflowRoute ?? 0, 4, 'L.015 local wetland outflow route'));
		out.push(rightInt(m.diversionRoute ?? 0, 4, 'L.016 diversion route'));
		const d = m.diversion ?? { bankfullCapacity: 0, efficiency: 0, maxMonthlyMm3: 0 };
		out.push([d.bankfullCapacity, d.efficiency, d.maxMonthlyMm3].map((v, k) => fixed(v, k === 0 ? 9 : 10, 3, `L.017[${k}]`)).join(''));
	}
	for (const line of m.trailingLines ?? []) out.push(line.text);
	return joinLines(out);
}
