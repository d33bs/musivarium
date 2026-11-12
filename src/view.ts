export interface ViewSettings {
  sort: 'random' | 'area-desc' | 'area-asc' | 'intensity';
  area: number;
  mean: number;
  overlay: boolean;
  context: boolean;
  size: number;
  contrast: 'auto' | 'fixed';
  low: number;
  high: number;
  hiddenChannels: number[];
}
export const DEFAULT_VIEW: ViewSettings = {
  sort: 'random',
  area: 0,
  mean: 0,
  overlay: true,
  context: true,
  size: 112,
  contrast: 'auto',
  low: 0,
  high: 25000,
  hiddenChannels: [],
};
export function parseView(url: string): ViewSettings {
  const params = new URL(url).searchParams,
    v = { ...DEFAULT_VIEW, hiddenChannels: [] as number[] };
  for (const key of Object.keys(v) as (keyof ViewSettings)[]) {
    const raw = params.get('v.' + key);
    if (raw === null) continue;
    if (key === 'hiddenChannels') v.hiddenChannels = raw ? raw.split(',').map(Number) : [];
    else if (typeof v[key] === 'number')
      (v as unknown as Record<string, unknown>)[key] = Number(raw);
    else if (typeof v[key] === 'boolean')
      (v as unknown as Record<string, unknown>)[key] = raw === 'true';
    else (v as unknown as Record<string, unknown>)[key] = raw;
  }
  if (
    !['random', 'area-desc', 'area-asc', 'intensity'].includes(v.sort) ||
    !['auto', 'fixed'].includes(v.contrast)
  )
    throw Error('Invalid display mode');
  if (!Number.isSafeInteger(v.size) || v.size < 72 || v.size > 180)
    throw Error('Invalid display size');
  if (![v.area, v.mean, v.low, v.high].every(Number.isFinite) || v.area < 0 || v.high <= v.low)
    throw Error('Invalid display range');
  if (
    v.hiddenChannels.length > 1000 ||
    v.hiddenChannels.some((i) => !Number.isSafeInteger(i) || i < 0)
  )
    throw Error('Invalid hidden display channels');
  return v;
}
export function withView(href: string, view: ViewSettings): string {
  const url = new URL(href);
  for (const [key, value] of Object.entries(view))
    url.searchParams.set('v.' + key, Array.isArray(value) ? value.join(',') : String(value));
  parseView(url.href);
  return url.href;
}
