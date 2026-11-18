import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerManifestChecks } from './manifest';
import { ServerController } from './server';
import { registerSideChecks } from './sides';
import { render } from './changes';
import { registerEventIndex } from './events';
import { EventTypes } from './eventTypes';
import { Definitions, type UpdateOutcome } from './updater';

const DOCS = 'https://lsmp.gg/resources/api';
const MANIFEST_KEYS = ['client_scripts', 'server_scripts', 'shared_scripts'];
const Target = vscode.ConfigurationTarget;

interface ApiEntry {
	name: string;
	side: string;
	sig: string;
	summary: string;
	url: string;
}

let definitions: Definitions;
let library: string;

const settings = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('lsmp');

async function isLsmpWorkspace(): Promise<boolean> {
	const mode = settings().get<string>('enable', 'auto');
	if (mode === 'always') return true;
	if (mode === 'never' || !vscode.workspace.workspaceFolders) return false;
	const manifests = await vscode.workspace.findFiles('**/manifest.json', '**/{node_modules,.git}/**', 200);
	for (const uri of manifests) {
		try {
			const json = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')) as Record<string, unknown>;
			if (json && typeof json === 'object' && MANIFEST_KEYS.some((key) => key in json)) return true;
		} catch {
			continue;
		}
	}
	return false;
}

function union(list: string[] | undefined, items: string[]): string[] {
	const out = [...(list ?? [])];
	for (const item of items) if (!out.includes(item)) out.push(item);
	return out;
}

async function apply(): Promise<void> {
	const lua = vscode.workspace.getConfiguration('Lua');
	const storage = definitions.storagePath.toLowerCase();
	const current = (lua.inspect<string[]>('workspace.library')?.workspaceValue ?? []).filter((entry) => !entry.toLowerCase().startsWith(storage));
	const ours = [path.join(library, 'lsmp'), ...(settings().get<boolean>('natives', true) ? [path.join(library, 'natives')] : [])];

	await lua.update('workspace.library', union(current, ours), Target.Workspace);
	await lua.update('runtime.version', 'Lua 5.5', Target.Workspace);
	await lua.update('workspace.checkThirdParty', false, Target.Workspace);
	await lua.update('workspace.ignoreDir', union(lua.get<string[]>('workspace.ignoreDir'), ['.git', 'node_modules', 'stream', 'web', 'dist']), Target.Workspace);
}

async function remove(): Promise<void> {
	const lua = vscode.workspace.getConfiguration('Lua');
	for (const key of ['workspace.library', 'runtime.version', 'workspace.checkThirdParty', 'workspace.ignoreDir', 'runtime.plugin', 'runtime.pluginArgs']) {
		await lua.update(key, undefined, Target.Workspace);
	}
}

async function onUpdate(outcome: UpdateOutcome, manual: boolean): Promise<void> {
	if (outcome.status === 'updated') {
		library = outcome.library;
		if (await isLsmpWorkspace()) await apply();
		const choice = await vscode.window.showInformationMessage(`LS:MP: definitions updated from lsmp.gg (${outcome.summary}).`, "What's changed");
		if (choice) await whatsChanged();
	} else if (manual && outcome.status === 'unchanged') {
		vscode.window.showInformationMessage('LS:MP: definitions are up to date.');
	} else if (manual && outcome.status === 'failed') {
		vscode.window.showWarningMessage(`LS:MP: update failed (${outcome.error}). Keeping the current definitions.`);
	}
}

async function whatsChanged(): Promise<void> {
	const file = path.join(definitions.storagePath, 'whats-changed.md');
	fs.writeFileSync(file, render(definitions.history()));
	await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(file));
}

async function updateNow(): Promise<void> {
	const outcome = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'LS:MP: checking lsmp.gg for new definitions…' },
		() => definitions.update(),
	);
	await onUpdate(outcome, true);
}

async function searchApi(): Promise<void> {
	const api = JSON.parse(fs.readFileSync(path.join(library, 'api.json'), 'utf8')) as ApiEntry[];
	const items = api.map((entry) => ({ label: entry.name, description: entry.side, detail: `${entry.sig}  —  ${entry.summary}`, url: entry.url }));
	const pick = await vscode.window.showQuickPick(items, {
		placeHolder: 'lsmp.…, engine event, Browser method…',
		matchOnDescription: true,
		matchOnDetail: true,
	});
	if (pick) await vscode.env.openExternal(vscode.Uri.parse(pick.url));
}

let lsmpWorkspace = false;
let updateTimer: NodeJS.Timeout | undefined;

function checkForUpdates(): void {
	void definitions.update().then((outcome) => onUpdate(outcome, false));
}

function stopUpdates(): void {
	if (updateTimer) clearInterval(updateTimer);
	updateTimer = undefined;
}

function scheduleUpdates(): void {
	stopUpdates();
	const hours = settings().get<number>('updateIntervalHours', 1);
	if (!lsmpWorkspace || !settings().get<boolean>('autoUpdate', true) || !(hours > 0)) return;
	updateTimer = setInterval(checkForUpdates, hours * 60 * 60 * 1000);
}

async function startEventTypes(context: vscode.ExtensionContext, events: ReturnType<typeof registerEventIndex>, log: vscode.OutputChannel): Promise<void> {
	const storage = context.globalStorageUri.fsPath;
	fs.mkdirSync(storage, { recursive: true });
	const plugin = path.join(storage, 'lsmp-types.lua');
	fs.copyFileSync(path.join(context.extensionUri.fsPath, 'plugin', 'lsmp-types.lua'), plugin);
	const typesFile = path.join(context.storageUri?.fsPath ?? storage, 'event-types.json');
	const lua = vscode.workspace.getConfiguration('Lua');
	const setArgs = (version: number): Thenable<void> => lua.update('runtime.pluginArgs', [typesFile, String(version)], Target.Workspace);
	if (lua.inspect<string>('runtime.plugin')?.workspaceValue !== plugin) await lua.update('runtime.plugin', plugin, Target.Workspace);
	const current = lua.inspect<string[]>('runtime.pluginArgs')?.workspaceValue;
	if (!current || current[0] !== typesFile) await setArgs(Date.now());
	context.subscriptions.push(new EventTypes(events, () => library, typesFile, async () => setArgs(Date.now()), log));
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const log = vscode.window.createOutputChannel('LS:MP Lua');
	definitions = new Definitions(context, log);
	library = definitions.current();
	const server = new ServerController(log);
	registerManifestChecks(context);
	registerSideChecks(context, () => library);
	const events = registerEventIndex(context, () => library);

	context.subscriptions.push(
		log,
		server,
		vscode.commands.registerCommand('lsmp.server.start', () => server.start()),
		vscode.commands.registerCommand('lsmp.server.stop', () => server.stop()),
		vscode.commands.registerCommand('lsmp.server.restart', () => server.restart()),
		vscode.commands.registerCommand('lsmp.server.metrics', () => server.showMetrics()),
		vscode.commands.registerCommand('lsmp.enable', async () => {
			await settings().update('enable', 'always', Target.Workspace);
			await apply();
			vscode.window.showInformationMessage('LS:MP Lua enabled for this workspace.');
		}),
		vscode.commands.registerCommand('lsmp.disable', async () => {
			await settings().update('enable', 'never', Target.Workspace);
			await remove();
			vscode.window.showInformationMessage('LS:MP Lua disabled for this workspace.');
		}),
		vscode.commands.registerCommand('lsmp.updateDefinitions', updateNow),
		vscode.commands.registerCommand('lsmp.whatsChanged', whatsChanged),
		vscode.commands.registerCommand('lsmp.searchApi', searchApi),
		vscode.commands.registerCommand('lsmp.openDocs', () => vscode.env.openExternal(vscode.Uri.parse(DOCS))),
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			if (event.affectsConfiguration('lsmp.natives') && (await isLsmpWorkspace())) await apply();
			if (event.affectsConfiguration('lsmp.autoUpdate') || event.affectsConfiguration('lsmp.updateIntervalHours')) scheduleUpdates();
		}),
		{ dispose: stopUpdates },
	);

	if (!(await isLsmpWorkspace())) return;
	lsmpWorkspace = true;
	await apply();
	if (settings().get<boolean>('eventTypes', true)) await startEventTypes(context, events, log);
	if (settings().get<boolean>('autoUpdate', true)) checkForUpdates();
	scheduleUpdates();
}

export function deactivate(): void {
	stopUpdates();
}
