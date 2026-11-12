import { it, expect } from 'vitest';
import { parseView, withView, DEFAULT_VIEW } from '../src/view';
it('round trips only validated display state independently of source selection', () => {
  const view = {
    ...DEFAULT_VIEW,
    sort: 'area-desc' as const,
    hiddenChannels: [1],
    context: false,
    overlay: true,
    contrast: 'fixed' as const,
    low: 5,
    high: 500,
  };
  const url = withView('https://example.org/?seed=42', view);
  expect(new URL(url).searchParams.get('seed')).toBe('42');
  expect(parseView(url)).toEqual(view);
  expect(() => parseView('https://example.org/?v.size=99999')).toThrow(/size/);
});
