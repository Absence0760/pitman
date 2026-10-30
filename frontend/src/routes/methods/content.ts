/**
 * What the Methods page states as data: the supported-features matrix, the
 * comparison with WRSM2000, the departures register and the data sources.
 * Every claim here is checked against the code or a doc where a test can
 * (`content.test.ts`), so a change in the engine fails there until this page
 * says the same. Percentages only: no reference value, network or client name
 * (issue #3 rule 2).
 */

export type FeatureStatus = 'Modelled' | 'Partly' | 'Not yet';

export interface Feature {
	readonly name: string;
	readonly status: FeatureStatus;
	/** What it does, what it doesn't, and how it was checked. */
	readonly detail: string;
}

export interface FeatureGroup {
	readonly title: string;
	readonly features: readonly Feature[];
}

export const FEATURE_GROUPS: readonly FeatureGroup[] = [
	{
		title: 'Runoff modules',
		features: [
			{
				name: 'Classic Pitman (groundwater model 0)',
				status: 'Modelled',
				detail: 'TT 690 ch.1. Checked against the manual’s equations and worked examples. Not yet compared with a WRSM2000 run: no public WR2012 output comes from a classic module.'
			},
			{
				name: 'Sami groundwater (model 2, method 2)',
				status: 'Partly',
				detail: 'TT 690 ch.8 and TT 687. Method 1 (hydrograph separation) isn’t built. Abstractions from a time-series file (AbstractionsOn = 2) aren’t read: the run warns and applies none. The borehole-yield curtailment of TT 687 eq. 14 has no field in the file and isn’t modelled.'
			},
			{
				name: 'Hughes groundwater (model 1)',
				status: 'Not yet',
				detail: 'TT 690 ch.7 is specified but not built. The parameters are kept in the file, but a run with a Hughes module fails and names the module. No reference network uses it.'
			},
			{ name: 'Paved areas', status: 'Modelled', detail: 'TT 690 §1.5 and §1.9: year tables interpolated, on free modules and SFR parents.' },
			{
				name: 'Afforestation',
				status: 'Partly',
				detail: 'Smoothed Gush (TT 690 eq. 11.1) and user-defined reductions run on SFR children. The CSIR, Van der Zel and LUT Gush curves aren’t printed in the manuals: a CSIR child uses Smoothed Gush targets, and those algorithms in a free module give no reduction. Each case warns.'
			},
			{
				name: 'Alien vegetation',
				status: 'Modelled',
				detail: 'The CSIR method of TT 690 ch.12, with the riparian deduction, on SFR children and on free modules with FT = 0. See departures DP-1 and DP-2.'
			},
			{
				name: 'SFR parents and children',
				status: 'Modelled',
				detail: 'TT 690 §11.2. The steps of the child calibration aren’t in the manuals; they follow the iteration traces WRSM2000 printed in public run logs, and are provisional. This is the largest gap in the comparison below.'
			}
		]
	},
	{
		title: 'Other modules',
		features: [
			{
				name: 'Reservoirs and lumped farm dams',
				status: 'Modelled',
				detail: 'TT 690 ch.2 and TT 689 ch.8: mass balance, net evaporation, spill, capacity by year, defined drafts, deficit priorities.'
			},
			{
				name: 'Channel reaches',
				status: 'Modelled',
				detail: 'Bed loss, defined flows and the principal route. Basic and comprehensive wetlands (TT 690 ch.9–10) and diversion channels are built from the manuals alone: no reference network uses them, so they are untested against WRSM2000.'
			},
			{
				name: 'Irrigation (RR)',
				status: 'Partly',
				detail: 'Simulated from TT 690 ch.3 to 6: demand, supply, application and return flow, for all four methods, with the water balance tested month by month. It has not been compared with WRSM2000, its defaults are provisional, and salinity is out of scope. In natural mode it is removed, as intended. The files are read, kept and saved (version 42 is read but not written).'
			},
			{
				name: 'Mines (MM)',
				status: 'Not yet',
				detail: 'Not modelled. The file is kept and saved unchanged, and its routes carry zero. No real mine file has been seen.'
			}
		]
	},
	{
		title: 'Network and runs',
		features: [
			{
				name: 'Routes, splits and solve order',
				status: 'Modelled',
				detail: 'One module at a time over the whole record, in .NET order, with percentage splits and upstream inflows. Cycles and dangling routes are refused.'
			},
			{
				name: 'Present day, natural and historical modes',
				status: 'Modelled',
				detail: 'Decision D1. Present day holds every year table and demand at the chosen year; natural removes development; historical follows the files.'
			},
			{ name: 'Defined flows and demand files', status: 'Modelled', detail: 'Read per mode: historical by year, present day at the chosen year, zero in natural mode.' },
			{ name: 'Daily time step', status: 'Not yet', detail: 'TT 690 ch.14. Out of scope: the model is monthly.' },
			{ name: 'Salinity', status: 'Not yet', detail: 'Out of scope.' }
		]
	},
	{
		title: 'Bringing a network up to date',
		features: [
			{
				name: 'Rainfall extension with CHIRPS (method A)',
				status: 'Modelled',
				detail: 'Twelve editable monthly bias factors over the overlap. Tested on synthetic data; every reference rainfall file extends with its original rows byte-identical. Not yet judged on real CHIRPS.'
			},
			{
				name: 'Hand calibration of a runoff module',
				status: 'Modelled',
				detail: 'POW to R and the Sami set, rerun in historical mode, fit at a gauge. FF and the year tables aren’t edited there.'
			},
			{
				name: 'Sub-dividing a quaternary (method B)',
				status: 'Partly',
				detail: 'Tributary and MAP-zone splits on a map, with each piece’s MAP scaled to the natural MAR (decision D2). Works here on invented boundaries and terrain only: real quaternary boundaries await a licence decision. No split network has yet been opened in WRSM2000, and a split Sami module may differ there (departure DP-5).'
			},
			{
				name: 'Land use and demands to 2025',
				status: 'Partly',
				detail: 'The afforestation, alien and paved tables and demand files can be edited, with a source for each value. Irrigated areas and farm dams come through a Cape Farm Mapper import that runs here on invented data only: the real service needs an access token. The DWS register and satellite surface water are not read yet.'
			},
			{ name: 'Extending observed gauge records', status: 'Not yet', detail: 'Observed .obs files are read and used as they stand.' }
		]
	},
	{
		title: 'Files',
		features: [
			{
				name: 'WRSM2000 files in and out',
				status: 'Modelled',
				detail: 'An unchanged file is written back byte for byte (every file of the reference set, checked); a changed one is written in WRSM2000’s standard layout. Provenance goes in pitman.json, which WRSM2000 ignores.'
			}
		]
	}
];

/** One line of the comparison with WRSM2000: percentages only. */
export interface Agreement {
	readonly what: string;
	readonly result: string;
}

/** When the comparison was last run, and over what. */
export const COMPARISON_DATE = '2026-10-29';

export const AGREEMENT: readonly Agreement[] = [
	{ what: 'Reference networks that run end to end', result: '97 %. The one that doesn’t lists a module before one it depends on, which Pitman refuses.' },
	{ what: 'All routes within 1 % of MAR and NSE at least 0.99', result: '43.5 %' },
	{ what: 'Runoff module routes', result: 'Median MAR difference +0.38 %, median NSE 0.998; 54 % within 1 % of MAR and NSE at least 0.99' },
	{ what: 'Free Sami modules, against WRSM2000’s module series', result: 'Median MAR difference +0.66 %, median NSE 1.000; 68 % within 2 % of MAR and NSE at least 0.97' },
	{ what: 'Routes of SFR children', result: 'Median absolute MAR difference 4.2 %' },
	{ what: 'Reservoirs, fed WRSM2000’s own route flows (a sample)', result: 'All within 1 % of spill MAR, NSE at least 0.996' }
];

export interface Departure {
	readonly id: string;
	readonly module: string;
	/** In plain language: what differs, by how much, and why. */
	readonly summary: string;
}

/** `docs/departures.md`, in plain language. The test holds the IDs to that file. */
export const DEPARTURES: readonly Departure[] = [
	{
		id: 'DP-1',
		module: 'SFR child with CSIR alien vegetation',
		summary:
			'The target MAR reduction differs from WRSM2000’s logged targets by 0.71 % on average (at most 3.53 %). TT 690 eq. 12.5 prints the tall-shrub constant as 3.1868; WRSM2000’s logs fit 3.4165 better. Pitman follows the manual.'
	},
	{
		id: 'DP-2',
		module: 'SFR child with CSIR alien vegetation',
		summary: 'The target low-flow reduction differs by 4.0 percentage points on average. WRSM2000 derives it from a flow series in a way the manuals don’t describe; Pitman takes the curve value, raised to the MAR reduction when below it.'
	},
	{
		id: 'DP-3',
		module: 'SFR child with CSIR afforestation',
		summary: 'The CSIR curves aren’t printed in the manuals, so the child is calibrated to Smoothed Gush targets, with a warning. The size of the difference can’t be measured: no reference child uses CSIR afforestation.'
	},
	{
		id: 'DP-5',
		module: 'A Sami module split into pieces',
		summary: 'Pitman scales each piece’s hydraulic gradient so its regional groundwater outflow keeps its depth, which assumes a width the manuals don’t give. WRSM2000 may differ when it runs a saved split network; no such run exists to measure it. Within Pitman the split changes nothing.'
	},
	{
		id: 'DP-4',
		module: 'Free module with CSIR, Van der Zel or LUT Gush afforestation',
		summary: 'Those curves aren’t printed in the manuals, so Pitman applies no reduction, with a warning. The size of the difference can’t be measured: no reference module uses them.'
	},
	{
		id: 'DP-6',
		module: 'An irrigation block with total return flows',
		summary: 'WRSM2000 reduces the runoff module’s outflow, and Pitman’s handling differs, especially in months of supply failure. Not measured yet.'
	},
	{
		id: 'DP-7',
		module: 'An irrigation block whose return flow enters a module listed before its supplier',
		summary: 'Pitman solves the supplier first, so that module gets the return as adjusted to the real supply. WRSM2000 appears to loop by month, so they may differ when the supplier falls short. Not measured yet.'
	}
];

/** Where the code knowingly follows something other than the manual's printed text. */
export const READINGS: readonly { readonly topic: string; readonly text: string }[] = [
	{ topic: 'Misprints', text: 'TT 690 eq. 1.10 has lost a minus sign, eq. 1.14 has the wrong sign on C2, and eq. 1.4 has lost its Σ. Pitman uses the corrected forms.' },
	{
		topic: 'Lag',
		text: 'TT 690 pp.4–5 prints a Muskingum form. WRSM2000’s module series fit a monthly time shift far better (median NSE 0.9993 against 0.892 for the printed monthly form), so Pitman uses the shift, and the printed form stays selectable in the engine.'
	},
	{ topic: 'Sami final runoff', text: 'Pitman uses the larger of the Pitman runoff and the Sami baseflow, less the transmission loss (TT 687 p.5 Fig 1, read literally), which fits WRSM2000’s module series best of the readings tried.' },
	{ topic: 'Starting soil moisture', text: 'The manuals don’t say. Half of ST, one pass, no warm-up year, as WRSM2000’s first months show.' },
	{ topic: 'SFR child steps', text: 'The manuals give the equations but not the step rules. Pitman follows the iteration traces in WRSM2000’s public run logs. That’s observed output, never the program’s code, and these defaults are provisional.' }
];

export type SourceStatus = 'In use' | 'With the map' | 'Planned' | 'Licence pending';

export interface DataSource {
	readonly name: string;
	readonly usedFor: string;
	readonly status: SourceStatus;
	readonly licence: string;
	/** The credit, word for word where a licence sets the words. */
	readonly credit: string;
	readonly url?: string;
}

/** The Art. 6(b) notice of the Copernicus WorldDEM-30 licence, word for word (docs/data.md § DEM). */
export const COPERNICUS_NOTICE =
	'produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved';

/** The same licence's Art. 6(c) liability sentence, word for word. */
export const COPERNICUS_LIABILITY = 'The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30';

export const DATA_SOURCES: readonly DataSource[] = [
	{
		name: 'CHIRPS v3 rainfall',
		usedFor: 'Extending rainfall files (method A). The date you fetched it is recorded in pitman.json.',
		status: 'In use',
		licence: 'CC BY 4.0',
		credit: 'Climate Hazards Center Infrared Precipitation with Stations version 3 (CHIRPS3) Data Repository: https://doi.org/10.15780/G2JQ0P (2025).',
		url: 'https://www.chc.ucsb.edu/data/chirps3'
	},
	{
		name: 'Copernicus GLO-30 elevation, as Mapterhorn tiles',
		usedFor: 'The map’s relief and tributary delineation.',
		status: 'With the map',
		licence: 'Copernicus WorldDEM-30 licence: free, adaptation and commercial use allowed',
		credit: `Relief and delineated catchments ${COPERNICUS_NOTICE}. ${COPERNICUS_LIABILITY}. Elevation tiles © Mapterhorn.`,
		url: 'https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf'
	},
	{
		name: 'OpenStreetMap basemap, as Protomaps tiles',
		usedFor: 'The map’s background.',
		status: 'With the map',
		licence: 'ODbL 1.0; label fonts SIL OFL 1.1',
		credit: '© Protomaps © OpenStreetMap contributors',
		url: 'https://www.openstreetmap.org/copyright'
	},
	{
		name: 'MAP grids: WAAS Southwestern Cape (about 100 m) and CHELSA v2.1 (about 1 km)',
		usedFor: 'Each sub-catchment’s starting MAP (method B, decision D6). CHELSA sets only the ratio between pieces.',
		status: 'With the map',
		licence: 'WAAS: terms not stated, Pitman’s decision pending. CHELSA: CC0 1.0',
		credit: 'Mean annual rainfall surface for the Southwestern Cape. Prepared for the WAAS project by Beuster Clarke & Associates. March 2007, Version 1.1. CHELSA: Karger et al. (2017), doi:10.1038/sdata.2017.122.'
	},
	{
		name: 'DWS quaternary boundaries',
		usedFor: 'The quaternary layer and the area CHIRPS is averaged over. Until the licence is settled you upload a boundary yourself.',
		status: 'Licence pending',
		licence: 'Commercial terms unconfirmed',
		credit: 'Department of Water and Sanitation'
	},
	{
		name: 'DWS register of dams',
		usedFor: 'Capacities of the larger dams (decision D4).',
		status: 'Licence pending',
		licence: 'No terms stated; DWS’s general wording is non-commercial',
		credit: 'Department of Water and Sanitation, Dam Safety Office'
	},
	{
		name: 'WR2012 naturalised MAR',
		usedFor: 'The target for each sub-catchment’s MAP. You enter the value and its table; Pitman holds no copy.',
		status: 'Licence pending',
		licence: 'WRC; redistribution terms unpublished',
		credit: 'Water Research Commission, WR2012'
	},
	{
		name: 'Cape Farm Mapper (Western Cape Department of Agriculture)',
		usedFor: 'Irrigated fields and dams at 2025 (decision D3).',
		status: 'Planned',
		licence: 'Western Cape Government copyright; terms to be confirmed',
		credit: 'Western Cape Department of Agriculture, Cape Farm Mapper',
		url: 'https://westerncape.gov.za/agriculture/service/capefarmmapper'
	},
	{
		name: 'JRC Global Surface Water; Digital Earth Africa Waterbodies',
		usedFor: 'Dam surface area × 3 m where no capacity is recorded (decision D4).',
		status: 'Planned',
		licence: 'JRC: free, without restriction of use (Copernicus). DE Africa: CC BY 4.0',
		credit: 'Source: EC JRC/Google. Contains Digital Earth Africa data (CC BY 4.0).'
	}
];

export interface Manual {
	readonly id: string;
	readonly title: string;
	readonly url: string;
}

export const MANUALS: readonly Manual[] = [
	{ id: 'TT 690/16', title: 'WRSM/Pitman Theory Manual', url: 'https://www.wrc.org.za/wp-content/uploads/mdocs/TT%20690-16.pdf' },
	{ id: 'TT 689/16', title: 'WRSM/Pitman User Manual', url: 'https://www.wrc.org.za/wp-content/uploads/mdocs/TT%20689-16.pdf' },
	{ id: 'TT 691/16', title: 'WRSM/Pitman Programmer’s Code Manual', url: 'https://www.wrc.org.za/wp-content/uploads/mdocs/TT%20691-16.pdf' },
	{ id: 'TT 687/16', title: 'WR2012 SAMI Groundwater module', url: 'https://www.wrc.org.za/wp-content/uploads/mdocs/TT%20687-16.pdf' }
];
