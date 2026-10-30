<!--
	Step 1: the quaternary and its runoff module. Quaternaries come from the
	service or the map; while the service has none (decision D-1) or fails,
	the user uploads the boundary, as the extension does. Every runoff module
	stays on offer: a network names quaternaries only in its module names.
-->
<script lang="ts">
	import { parseArea, parseQuaternaries } from '#lib/extend/area.js';
	import { choicesFor, quaternaryGroups, type Loaded, type RunoffChoice, type Upload } from './modules.js';

	let {
		loaded,
		choices,
		code,
		moduleNumber,
		disabled = false,
		onchoose,
		onmodule,
		onupload,
		onretry
	}: {
		loaded: Loaded;
		choices: readonly RunoffChoice[];
		code: string;
		moduleNumber: number | undefined;
		disabled?: boolean;
		onchoose: (code: string) => void;
		onmodule: (number: number | undefined) => void;
		/** The boundary uploaded and its code, `undefined` when it is no longer usable. */
		onupload: (upload: Upload | undefined) => void;
		onretry: () => void;
	} = $props();

	const groups = $derived(loaded.state === 'ok' ? quaternaryGroups(loaded.collection, choices) : undefined);
	const moduleGroups = $derived(choicesFor(choices, code));

	let fileName = $state('');
	let parsed = $state.raw<Upload['geometry'] | undefined>();
	let fileError = $state<string | undefined>();
	let codeText = $state('');
	const typed = $derived(parseQuaternaries(codeText));
	const typedCode = $derived(typed.codes.length === 1 && typed.invalid.length === 0 ? typed.codes[0] : undefined);
	const codeError = $derived(codeText.trim() !== '' && typedCode === undefined ? 'Type one quaternary code: a letter, two digits, a letter.' : undefined);

	function report() {
		onupload(parsed && typedCode ? { fileName, geometry: parsed, code: typedCode } : undefined);
	}

	async function readFile(event: Event & { currentTarget: HTMLInputElement }) {
		const file = event.currentTarget.files?.[0];
		parsed = undefined;
		fileError = undefined;
		report();
		if (!file) return;
		fileName = file.name;
		let text: string;
		try {
			text = await file.text();
		} catch {
			fileError = `${file.name} could not be read.`;
			return;
		}
		const result = parseArea(text);
		if (result.ok) parsed = result.geometry;
		else fileError = `${file.name}: ${result.error}`;
		report();
	}
</script>

{#if loaded.state === 'loading'}
	<p class="note" role="status">Loading the quaternaries…</p>
{:else if loaded.state === 'failed'}
	<p class="warn">
		<strong>No quaternaries from the service:</strong>
		{loaded.message}
		<button type="button" class="retry" onclick={onretry}>Try again</button>
	</p>
{/if}

{#if groups}
	<div class="field">
		<label for="subdivide-quaternary">Quaternary</label>
		<select id="subdivide-quaternary" value={code} {disabled} onchange={(e) => onchoose(e.currentTarget.value)}>
			<option value="">Choose a quaternary, or click one on the map</option>
			{#if groups.inNetwork.length > 0}
				<optgroup label="Named by this network’s modules">
					{#each groups.inNetwork as c (c)}<option value={c}>{c}</option>{/each}
				</optgroup>
			{/if}
			{#if groups.others.length > 0}
				<optgroup label={groups.inNetwork.length > 0 ? 'Other quaternaries' : 'Quaternaries'}>
					{#each groups.others as c (c)}<option value={c}>{c}</option>{/each}
				</optgroup>
			{/if}
		</select>
	</div>
{/if}

<details class="own" open={loaded.state === 'failed'}>
	<summary>Use your own boundary file</summary>
	<p class="note">
		A GeoJSON Polygon or MultiPolygon in longitude/latitude, as for a rainfall extension. Only the shape is sent to Pitman’s services, never the network’s files.
	</p>
	<div class="field">
		<input
			id="subdivide-boundary"
			class="file-pick"
			type="file"
			accept=".geojson,.json,application/geo+json,application/json"
			aria-invalid={fileError ? 'true' : undefined}
			aria-describedby={fileError ? 'subdivide-boundary-error' : undefined}
			{disabled}
			onchange={readFile}
		/>
		<label for="subdivide-boundary">Boundary file (GeoJSON)</label>
	</div>
	{#if fileError}
		<p id="subdivide-boundary-error" class="error" role="alert">{fileError}</p>
	{:else if parsed}
		<p class="note">Read {fileName}.</p>
	{/if}
	<div class="field">
		<label for="subdivide-code">Its quaternary code</label>
		<input
			id="subdivide-code"
			type="text"
			autocomplete="off"
			spellcheck="false"
			placeholder="e.g. Z01A"
			bind:value={codeText}
			{disabled}
			aria-invalid={codeError ? 'true' : undefined}
			aria-describedby={codeError ? 'subdivide-code-error' : undefined}
			oninput={report}
		/>
	</div>
	{#if codeError}
		<p id="subdivide-code-error" class="error">{codeError}</p>
	{/if}
</details>

{#if choices.length === 0}
	<p class="note">This network has no runoff module to split.</p>
{:else}
	<div class="field">
		<label for="subdivide-module">Runoff module to split</label>
		<select id="subdivide-module" value={moduleNumber ?? ''} {disabled} onchange={(e) => onmodule(e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))}>
			<option value="">Choose a runoff module</option>
			{#if moduleGroups.named.length > 0}
				<optgroup label={`Named for ${code}`}>
					{#each moduleGroups.named as c (c.ref.number)}<option value={c.ref.number}>{c.label}</option>{/each}
				</optgroup>
			{/if}
			{#if moduleGroups.others.length > 0}
				<optgroup label={moduleGroups.named.length > 0 ? 'Other runoff modules' : 'Runoff modules'}>
					{#each moduleGroups.others as c (c.ref.number)}<option value={c.ref.number}>{c.label}</option>{/each}
				</optgroup>
			{/if}
		</select>
	</div>
{/if}

<style>
	.field {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.25rem;
		margin: 0.5rem 0;
	}
	.field select,
	.field input[type='text'] {
		width: 100%;
		max-width: 26rem;
	}
	.own {
		margin: 0.5rem 0;
	}
	.retry {
		margin-left: 0.5rem;
	}
</style>
