import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Route } from '@playwright/test';

export const source = 'https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr/';
const directory = new URL('../fixtures/idr0076/', import.meta.url);
export const fixtureManifest = JSON.parse(
  readFileSync(new URL('manifest.json', directory), 'utf8'),
) as {
  entries: {
    url: string;
    key: string;
    file: string;
    sha256: string;
    bytes: number;
    status: number;
    contentType: string;
  }[];
};
/** HTTP entity bodies remain byte-for-byte originals, including compressed chunks. */
export async function installIdrFixtures(
  context: BrowserContext,
  override?: (route: Route) => Promise<boolean>,
) {
  const requests: string[] = [],
    unexpected: string[] = [],
    blockedSoftwareRequests: string[] = [];
  const entries = new Map(
    fixtureManifest.entries.map((entry) => {
      const body = readFileSync(fileURLToPath(new URL(entry.file, directory)));
      if (
        body.length !== entry.bytes ||
        createHash('sha256').update(body).digest('hex') !== entry.sha256
      )
        throw Error(`Corrupt IDR fixture: ${entry.key}`);
      return [entry.url, { ...entry, body }] as const;
    }),
  );
  // No app WebSockets exist: disable only Vite HMR during concurrent authoring.
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (new URL(url).hostname === '127.0.0.1') return route.continue();
    // Offline layout uses system fallback fonts; no Google network dependency.
    if (new URL(url).hostname === 'fonts.googleapis.com')
      return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    if (new URL(url).hostname === 'extensions.duckdb.org') {
      blockedSoftwareRequests.push(url);
      return route.abort('blockedbyclient');
    }
    requests.push(url);
    if (override && (await override(route))) return;
    const entry = entries.get(url);
    if (!entry) {
      unexpected.push(url);
      await route.abort('blockedbyclient');
      return;
    }
    await route.fulfill({
      status: entry.status,
      body: entry.body,
      headers: {
        'Content-Type': entry.contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });
  });
  return { requests, unexpected, blockedSoftwareRequests };
}
