export const SOURCES = {
	sdk: 'https://lsmp.gg/resources/sdk.json',
	natives: 'https://lsmp.gg/resources/natives.json',
} as const;

export type SourceName = keyof typeof SOURCES;

export interface Validator {
	etag?: string;
	lastModified?: string;
}

export type Fetched = { changed: false } | { changed: true; text: string; validator: Validator };

export async function fetchSource(url: string, validator: Validator = {}, timeoutMs = 30000): Promise<Fetched> {
	const headers: Record<string, string> = { 'user-agent': 'lsmp-lua-vscode' };
	if (validator.etag) headers['if-none-match'] = validator.etag;
	if (validator.lastModified) headers['if-modified-since'] = validator.lastModified;
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
	if (response.status === 304) return { changed: false };
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	return {
		changed: true,
		text: await response.text(),
		validator: { etag: response.headers.get('etag') ?? undefined, lastModified: response.headers.get('last-modified') ?? undefined },
	};
}
