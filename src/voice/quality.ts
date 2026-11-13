/** Detect likely ASR decoder loops so a user can review before saving.
 * This never rewrites the transcript: deletion risks removing a legitimate
 * repeated scientific phrase, and detection alone cannot prove a loop is
 * wrong without the reference text this app does not have.
 */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

const PHRASE_LENGTH = 6;
const MIN_REPEATS = 8;

export function transcriptWarnings(text: string): string[] {
  const words = tokens(text);
  const counts = new Map<string, number>();
  for (let i = 0; i <= words.length - PHRASE_LENGTH; i++) {
    const phrase = words.slice(i, i + PHRASE_LENGTH).join(' ');
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  const worst = Math.max(0, ...counts.values());
  if (worst < MIN_REPEATS) return [];
  return [
    'This transcript repeats the same phrase many times in a row, which can happen when local speech recognition loses track of long audio. Review it carefully before saving, or re-record a shorter note.',
  ];
}
