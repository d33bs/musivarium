import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Generated 440-Hz device-simulation fixture, NOT a real human microphone test. */
export function fakeMicrophoneWav(): string {
  const directory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'musivarium-voice-'));
  const rate = 48000;
  const frames = rate * 8;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    wav.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  const file = join(directory, 'tone.wav');
  writeFileSync(file, wav);
  process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
  return file;
}
