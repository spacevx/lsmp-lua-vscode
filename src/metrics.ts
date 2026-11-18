import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as os from 'node:os';
import * as vscode from 'vscode';

const HISTORY = 300;
const INTERVAL_MS = 1000;

export interface Sample {
	at: number;
	cpu: number;
	ramMb: number;
	ioKbps: number;
	threads: number;
	handles: number;
}

interface Raw {
	at: number;
	cpuMs: number;
	ram: number;
	io: number;
	threads: number;
	handles: number;
}

const SAMPLER = (pid: number, interval: number): string =>
	[
		`$id = ${pid}`,
		'while ($true) {',
		'  $g = Get-Process -Id $id -ErrorAction SilentlyContinue',
		'  if (-not $g) { break }',
		'  $w = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue',
		'  $io = if ($w) { [double]$w.ReadTransferCount + [double]$w.WriteTransferCount + [double]$w.OtherTransferCount } else { 0 }',
		'  [Console]::Out.WriteLine(("{0}|{1}|{2}|{3}|{4}" -f [int64]$g.TotalProcessorTime.TotalMilliseconds, $g.WorkingSet64, $io, $g.Threads.Count, $g.HandleCount))',
		`  Start-Sleep -Milliseconds ${interval}`,
		'}',
	].join('\n');

export class ProcessMetrics implements vscode.Disposable {
	private sampler: ChildProcessWithoutNullStreams | undefined;
	private previous: Raw | undefined;
	private buffer = '';
	readonly history: Sample[] = [];
	private readonly changed = new vscode.EventEmitter<Sample>();
	readonly onSample = this.changed.event;

	start(pid: number): void {
		this.stop();
		this.history.length = 0;
		this.previous = undefined;
		if (process.platform !== 'win32') return;
		const encoded = Buffer.from(SAMPLER(pid, INTERVAL_MS), 'utf16le').toString('base64');
		const sampler = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
		this.sampler = sampler;
		sampler.stdout.setEncoding('utf8');
		sampler.stdout.on('data', (chunk: string) => this.read(chunk));
		sampler.on('exit', () => {
			if (this.sampler === sampler) this.sampler = undefined;
		});
	}

	stop(): void {
		this.sampler?.kill();
		this.sampler = undefined;
	}

	private read(chunk: string): void {
		this.buffer += chunk;
		const lines = this.buffer.split(/\r?\n/);
		this.buffer = lines.pop() ?? '';
		for (const line of lines) {
			const parts = line.trim().split('|').map(Number);
			if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n))) continue;
			const [cpuMs, ram, io, threads, handles] = parts;
			this.push({ at: Date.now(), cpuMs, ram, io, threads, handles });
		}
	}

	private push(raw: Raw): void {
		const previous = this.previous;
		this.previous = raw;
		if (!previous) return;
		const elapsed = Math.max(raw.at - previous.at, 1);
		const sample: Sample = {
			at: raw.at,
			cpu: Math.max(0, ((raw.cpuMs - previous.cpuMs) / elapsed / os.cpus().length) * 100),
			ramMb: raw.ram / (1024 * 1024),
			ioKbps: Math.max(0, (raw.io - previous.io) / 1024 / (elapsed / 1000)),
			threads: raw.threads,
			handles: raw.handles,
		};
		this.history.push(sample);
		if (this.history.length > HISTORY) this.history.shift();
		this.changed.fire(sample);
	}

	dispose(): void {
		this.stop();
		this.changed.dispose();
	}
}

const PAGE = (nonce: string): string => `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 16px; }
h1 { font-size: 13px; font-weight: 600; margin: 0 0 12px; opacity: .8; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
.card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; }
.head { display: flex; justify-content: space-between; align-items: baseline; }
.label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; opacity: .7; }
.value { font-size: 20px; font-variant-numeric: tabular-nums; }
.peak { font-size: 11px; opacity: .6; font-variant-numeric: tabular-nums; }
canvas { width: 100%; height: 90px; display: block; margin-top: 6px; }
.small { display: flex; gap: 24px; margin-top: 12px; font-size: 12px; opacity: .8; font-variant-numeric: tabular-nums; }
.idle { opacity: .6; font-size: 12px; }
</style></head>
<body>
<h1 id="title">LS:MP server</h1>
<div class="grid">
  <div class="card"><div class="head"><span class="label">CPU</span><span class="peak" id="cpuPeak"></span></div><div class="value" id="cpu">–</div><canvas id="cpuChart"></canvas></div>
  <div class="card"><div class="head"><span class="label">Memory</span><span class="peak" id="ramPeak"></span></div><div class="value" id="ram">–</div><canvas id="ramChart"></canvas></div>
  <div class="card"><div class="head"><span class="label">I/O (disk + network)</span><span class="peak" id="ioPeak"></span></div><div class="value" id="io">–</div><canvas id="ioChart"></canvas></div>
</div>
<div class="small"><span id="threads"></span><span id="handles"></span><span id="uptime"></span></div>
<p class="idle" id="idle">Waiting for the server…</p>
<script nonce="${nonce}">
const css = getComputedStyle(document.body);
const colors = { cpu: css.getPropertyValue('--vscode-charts-blue') || '#3794ff', ram: css.getPropertyValue('--vscode-charts-green') || '#89d185', io: css.getPropertyValue('--vscode-charts-orange') || '#d18616' };
const fmt = { cpu: (v) => v.toFixed(1) + ' %', ram: (v) => v.toFixed(0) + ' MB', io: (v) => v >= 1024 ? (v / 1024).toFixed(2) + ' MB/s' : v.toFixed(0) + ' KB/s' };
let samples = [];
let startedAt = 0;
function draw(id, key, color, fixedMax) {
  const canvas = document.getElementById(id);
  const ratio = devicePixelRatio || 1;
  const w = canvas.clientWidth * ratio, h = canvas.clientHeight * ratio;
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (samples.length < 2) return;
  const values = samples.map((s) => s[key]);
  const max = fixedMax || Math.max(...values) * 1.15 || 1;
  const step = w / (300 - 1);
  const x0 = w - (values.length - 1) * step;
  g.beginPath();
  values.forEach((v, i) => { const x = x0 + i * step, y = h - (v / max) * (h - 4) - 2; i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.strokeStyle = color.trim(); g.lineWidth = 1.5 * ratio; g.stroke();
  g.lineTo(w, h); g.lineTo(x0, h); g.closePath();
  g.globalAlpha = 0.15; g.fillStyle = color.trim(); g.fill(); g.globalAlpha = 1;
}
function render() {
  document.getElementById('idle').style.display = samples.length ? 'none' : 'block';
  if (!samples.length) return;
  const last = samples[samples.length - 1];
  const peak = (k) => Math.max(...samples.map((s) => s[k]));
  for (const [key, field] of [['cpu', 'cpu'], ['ram', 'ramMb'], ['io', 'ioKbps']]) {
    document.getElementById(key).textContent = fmt[key](last[field]);
    document.getElementById(key + 'Peak').textContent = 'peak ' + fmt[key](peak(field));
  }
  document.getElementById('threads').textContent = last.threads + ' threads';
  document.getElementById('handles').textContent = last.handles + ' handles';
  if (startedAt) { const s = Math.floor((Date.now() - startedAt) / 1000); document.getElementById('uptime').textContent = 'up ' + Math.floor(s / 60) + 'm ' + (s % 60) + 's'; }
  draw('cpuChart', 'cpu', colors.cpu, 100);
  draw('ramChart', 'ramMb', colors.ram);
  draw('ioChart', 'ioKbps', colors.io);
}
window.addEventListener('message', (event) => {
  const m = event.data;
  if (m.type === 'reset') { samples = m.history; startedAt = m.startedAt; document.getElementById('title').textContent = m.title; }
  if (m.type === 'sample') { samples.push(m.sample); if (samples.length > 300) samples.shift(); }
  render();
});
window.addEventListener('resize', render);
</script></body></html>`;

export class MetricsPanel {
	private static current: MetricsPanel | undefined;
	private readonly subscription: vscode.Disposable;

	private constructor(private readonly panel: vscode.WebviewPanel, private readonly metrics: ProcessMetrics, private readonly info: () => { title: string; startedAt: number }) {
		const nonce = Math.random().toString(36).slice(2);
		panel.webview.html = PAGE(nonce);
		this.subscription = metrics.onSample((sample) => void panel.webview.postMessage({ type: 'sample', sample }));
		panel.onDidDispose(() => {
			this.subscription.dispose();
			MetricsPanel.current = undefined;
		});
		this.reset();
	}

	reset(): void {
		void this.panel.webview.postMessage({ type: 'reset', history: this.metrics.history, ...this.info() });
	}

	static show(metrics: ProcessMetrics, info: () => { title: string; startedAt: number }): void {
		if (MetricsPanel.current) {
			MetricsPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
			return;
		}
		const panel = vscode.window.createWebviewPanel('lsmpMetrics', 'LS:MP Server', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
		MetricsPanel.current = new MetricsPanel(panel, metrics, info);
	}

	static refresh(): void {
		MetricsPanel.current?.reset();
	}
}
