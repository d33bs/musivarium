import { expect, it } from 'vitest';
import { transcriptWarnings } from '../src/voice/quality';

it('flags long consecutive phrase loops without rewriting the transcript', () => {
  const transcript = 'Inspect the nucleus. ' + 'the third one '.repeat(30) + 'Review fluorescence.';
  expect(transcriptWarnings(transcript)).toHaveLength(1);
  expect(transcriptWarnings(transcript)[0]).toMatch(/repeat|review/i);
  expect(transcript).toContain('the third one '.repeat(30));
});
it('does not treat ordinary terminology reuse or one repeated observation as an accuracy failure', () => {
  for (const text of [
    '',
    'nucleus',
    'Inspect the nucleus and cytoplasm. Review the fluorescence and segmentation.',
    'The nucleus appears round. The nucleus has bright fluorescence. The nucleus is in the middle.',
    'check this region check this region',
  ])
    expect(transcriptWarnings(text)).toEqual([]);
});
it('matches loops across case and punctuation while making no claim about correctness', () => {
  const variants = Array.from({ length: 10 }, (_, i) =>
    i % 2 ? 'Check this region!' : 'CHECK this region.',
  ).join(' ');
  expect(transcriptWarnings(variants)).toHaveLength(1);
});
