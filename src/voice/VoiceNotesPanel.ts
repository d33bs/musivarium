import './voice.css';
import { download } from '../exports';
import { VoiceRecorder, microphoneError } from './recorder';
import { wavBlob } from './audio';
import { AsrClient } from './asr-client';
import {
  createNote,
  exportNotes,
  MAX_NOTE_LENGTH,
  NotesStore,
  snapshotContext,
  validateNote,
} from './notes-store';
import type { Transcript, VoiceContext, VoiceNote } from './types';
import { associationKey } from './context';
import { transcriptWarnings } from './quality';

type Phase =
  'idle' | 'permission' | 'recording' | 'preparing' | 'transcribing' | 'saving' | 'deleting';

/** One small local editor shared by the virtualized tiles; no model is loaded here. */
export class VoiceNotesPanel {
  private readonly store = new NotesStore();
  private readonly recorder = new VoiceRecorder();
  private readonly asr = new AsrClient();
  private readonly dialog: HTMLDialogElement;
  private readonly text: HTMLTextAreaElement;
  private phase: Phase = 'idle';
  private epoch = 0;
  private context: VoiceContext = { selectedCellIds: [] };
  private draftContext: VoiceContext = { selectedCellIds: [] };
  private locked = false;
  private all = true;
  private notes: VoiceNote[] = [];
  private editing?: VoiceNote;
  private transcript?: Transcript;
  private audio?: Float32Array;
  private previewUrl?: string;
  private savedText = '';
  private storageError = '';

  constructor(
    private readonly host: HTMLElement,
    private readonly options: {
      prepareRecording: () => void;
      onChange: (notes: VoiceNote[]) => void;
    },
  ) {
    host.className = 'voice-notes-box';
    host.innerHTML = `
      <div class="voice-box-heading"><h3>Voice notes</h3><span id="voice-count" class="hint">Stored only in this browser.</span><button id="voice-all" class="secondary" type="button">All notes</button></div>
      <p class="hint">Use a tile’s microphone to record or write a note about that cell. No audio is stored.</p>
      <dialog id="voice-notes-dialog" aria-labelledby="voice-title" aria-describedby="voice-privacy">
        <div class="dialog-head"><h2 id="voice-title">Voice notes</h2><button id="voice-close" class="secondary" type="button" aria-label="Close voice notes">Close ×</button></div>
        <p id="voice-context" class="voice-context"></p>
        <p id="voice-lock" class="hint">Context is locked when you start recording or writing, not when you save.</p>
        <p id="voice-privacy" class="hint">Local English transcription. First transcription downloads Whisper Tiny English model files from Hugging Face (tens of MB), plus runtime assets. Audio and text are not uploaded. Browser caches can be cleared or evicted; offline operation is not guaranteed. No cloud speech fallback.</p>
        <div class="voice-actions"><button id="voice-record" class="primary" type="button">Record note</button><button id="voice-stop" class="primary" type="button" hidden>Stop & transcribe</button><button id="voice-cancel" class="secondary" type="button" hidden>Discard / cancel</button><button id="voice-new" class="secondary" type="button">New text note</button><span id="voice-elapsed" role="timer" aria-label="Recording time" hidden></span></div>
        <p id="voice-status" class="voice-status" role="status" aria-live="polite"></p>
        <progress id="voice-progress" aria-label="Local transcription progress" hidden></progress><p id="voice-audio-warning" class="hint" hidden></p><p id="voice-transcript-warning" class="hint error" hidden></p>
        <audio id="voice-preview" controls preload="none" aria-label="Unsaved recording preview" hidden></audio>
        <button id="voice-retry" class="secondary" type="button" hidden>Retry local transcription</button>
        <label for="voice-text">Note text · edit before saving</label><textarea id="voice-text" rows="5" maxlength="${MAX_NOTE_LENGTH}" placeholder="Type a note, or record up to 90 seconds. Scientific terms may need correction." spellcheck="true"></textarea>
        <div class="voice-actions voice-save-actions"><button id="voice-save" class="primary" type="button" disabled>Save note locally</button><button id="voice-export-draft" class="secondary" type="button" disabled>Export draft JSON</button></div>
        <p class="hint">Notes stay on this origin and browser profile in IndexedDB, not in the image or shared link. Export a backup before clearing site data. Raw audio is never saved.</p>
        <div class="voice-list-heading"><h3>Saved notes</h3><button id="voice-scope" class="secondary" type="button">Show all saved notes</button><button id="voice-export" class="secondary" type="button" disabled>Export listed notes JSON</button></div>
        <div id="voice-list" aria-label="Saved local voice notes"></div>
      </dialog>`;
    this.dialog = this.el<HTMLDialogElement>('voice-notes-dialog');
    this.text = this.el<HTMLTextAreaElement>('voice-text');
    this.button('voice-all').onclick = () => this.open();
    this.button('voice-close').onclick = () => this.close();
    this.button('voice-record').onclick = () => void this.record();
    this.button('voice-stop').onclick = () => void this.stop();
    this.button('voice-cancel').onclick = () => this.cancel();
    this.button('voice-new').onclick = () => {
      if (!this.keepDraft()) {
        this.resetDraft();
        this.text.focus();
      }
    };
    this.button('voice-retry').onclick = () => void this.transcribe();
    this.button('voice-save').onclick = () => void this.save();
    this.button('voice-export-draft').onclick = () => {
      try {
        this.export([this.draftNote()], 'musivarium-note-draft.json');
      } catch (error) {
        this.error(error);
      }
    };
    this.button('voice-export').onclick = () =>
      this.export(this.listedNotes(), 'musivarium-voice-notes.json');
    this.button('voice-scope').onclick = () => {
      this.all = !this.all;
      this.renderList();
    };
    this.text.oninput = () => {
      if (!this.locked) this.lockContext();
      this.showTranscriptWarning(this.text.value);
      this.controls();
    };
    this.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    });
    // A page in the back-forward cache must not keep recording or retain a model.
    window.addEventListener('pagehide', () => {
      this.cancel(false);
      this.store.close();
    });
    window.addEventListener('beforeunload', (event) => {
      if (this.isBusy || this.dirty) event.preventDefault();
    });
    void this.refresh().catch((error) => this.error(error));
    this.controls();
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.host.querySelector<T>('#' + id)!;
  }
  private button(id: string) {
    return this.el<HTMLButtonElement>(id);
  }
  get isBusy(): boolean {
    return this.phase !== 'idle';
  }
  private get dirty(): boolean {
    return this.text.value !== this.savedText || this.audio !== undefined;
  }

  open(context: VoiceContext = { selectedCellIds: [] }): void {
    if (this.isBusy) {
      this.status('Finish or cancel the current voice task first.', true);
      return;
    }
    if (this.keepDraft()) return;
    this.context = structuredClone(context);
    this.all = !context.selectedCellIds.length;
    this.resetDraft();
    this.dialog.showModal();
    this.text.focus();
    void this.refresh().catch((error) => this.error(error));
  }

  private keepDraft(): boolean {
    return (
      this.isBusy ||
      (this.dirty &&
        !window.confirm('Discard the unsaved recording or note? This cannot be undone.'))
    );
  }

  private close(): void {
    if (this.phase === 'saving' || this.phase === 'deleting') {
      this.status('Wait for the local write to finish.');
      return;
    }
    if (
      (this.isBusy || this.dirty) &&
      !window.confirm('Discard this unsaved recording or note and close?')
    )
      return;
    this.cancel(false);
    this.resetDraft();
    this.dialog.close();
  }

  private lockContext(): void {
    this.draftContext = snapshotContext(this.draftContext);
    this.locked = true;
    this.renderContext();
  }

  private renderContext(): void {
    const c = this.draftContext;
    this.el('voice-context').textContent = c.selectedCellIds.length
      ? `${c.selectedCellIds.join(', ')} · ${c.imageId ?? 'image'}${c.plane ? ` · level ${c.plane.level}, T ${c.plane.t}, Z ${c.plane.z}, channel(s) ${c.plane.channels.join(', ')}` : ''}${c.labelSource ? ` · label source ${c.labelSource}` : c.segmentationModel ? ` · segmentation ${c.segmentationModel}` : ''}`
      : 'Unattached note · no cell selected. Use a tile’s microphone for image/cell context.';
    this.el('voice-lock').textContent = this.locked
      ? `Context locked at ${c.contextCapturedAt ?? 'original creation'}. Changing the mosaic cannot reattach this note.`
      : 'Context will lock when you start recording or writing, not when you save.';
  }

  private clearPreview(): void {
    const preview = this.el<HTMLAudioElement>('voice-preview');
    preview.pause();
    preview.removeAttribute('src');
    preview.load();
    preview.hidden = true;
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = undefined;
  }

  private resetDraft(): void {
    this.clearPreview();
    this.audio = undefined;
    this.el('voice-audio-warning').textContent = '';
    this.el('voice-audio-warning').hidden = true;
    this.transcript = undefined;
    this.editing = undefined;
    this.text.value = '';
    this.savedText = '';
    this.draftContext = structuredClone(this.context);
    this.locked = false;
    this.el('voice-retry').hidden = true;
    this.showTranscriptWarning('');
    this.status(this.storageError);
    this.renderContext();
    this.controls();
    this.renderList();
  }

  private showTranscriptWarning(text: string): void {
    const warnings = transcriptWarnings(text);
    this.el('voice-transcript-warning').textContent = warnings.join(' ');
    this.el('voice-transcript-warning').hidden = !warnings.length;
  }

  private status(message: string, error = false): void {
    this.el('voice-status').textContent = message;
    this.el('voice-status').classList.toggle('error', error);
  }
  private error(error: unknown): void {
    this.status(error instanceof Error ? error.message : String(error), true);
  }

  private controls(): void {
    this.button('voice-record').disabled = this.isBusy || !!this.editing;
    this.button('voice-new').disabled = this.isBusy;
    this.button('voice-stop').hidden = this.phase !== 'recording';
    this.button('voice-cancel').hidden =
      !this.isBusy || this.phase === 'saving' || this.phase === 'deleting';
    this.button('voice-save').disabled = this.isBusy || !this.text.value.trim();
    this.button('voice-export-draft').disabled = this.isBusy || !this.text.value.trim();
    this.button('voice-retry').disabled = this.isBusy;
    this.text.readOnly = this.isBusy;
    for (const control of this.host.querySelectorAll<HTMLButtonElement>(
      '.voice-edit, .voice-delete',
    ))
      control.disabled = this.isBusy;
    this.el('voice-progress').hidden = this.phase !== 'transcribing' && this.phase !== 'preparing';
    this.el('voice-elapsed').hidden = this.phase !== 'recording';
    this.dialog.setAttribute('aria-busy', String(this.isBusy));
  }

  private async record(): Promise<void> {
    if (this.keepDraft()) return;
    try {
      this.options.prepareRecording();
    } catch (error) {
      this.error(error);
      return;
    }
    this.resetDraft();
    this.lockContext(); // Snapshot BEFORE requesting permission; never use the later selection.
    const epoch = ++this.epoch;
    this.phase = 'permission';
    this.status('Requesting microphone permission… You can cancel and use text instead.');
    this.controls();
    try {
      await this.recorder.start({
        onProgress: (seconds) => {
          if (epoch !== this.epoch) return;
          this.el('voice-elapsed').textContent = `${seconds.toFixed(1)} / 90 s`;
          if (seconds >= 80)
            this.status('Recording · 90-second limit approaching. Stop when ready.');
        },
        onLimit: () => {
          if (epoch === this.epoch) void this.stop();
        },
        onError: (error) => {
          if (epoch !== this.epoch) return;
          this.cancel(false);
          this.error(error);
        },
      });
      if (epoch !== this.epoch) return;
      this.phase = 'recording';
      this.el('voice-elapsed').textContent = '0.0 / 90 s';
      this.status('Recording locally. Stop to transcribe, or discard.');
      this.controls();
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.recorder.discard();
      this.phase = 'idle';
      this.status(microphoneError(error), true);
      this.controls();
    }
  }

  private async stop(): Promise<void> {
    if (this.phase !== 'recording') return;
    const epoch = this.epoch;
    this.phase = 'preparing';
    this.status('Stopping microphone and preparing 16-kHz audio…');
    this.controls();
    try {
      const audio = await this.recorder.stop();
      if (epoch !== this.epoch) return;
      this.audio = audio.samples;
      this.el('voice-audio-warning').textContent = audio.warnings.join(' ');
      this.el('voice-audio-warning').hidden = !audio.warnings.length;
      const preview = this.el<HTMLAudioElement>('voice-preview');
      this.previewUrl = URL.createObjectURL(wavBlob(audio.samples));
      preview.src = this.previewUrl;
      preview.hidden = false;
      this.phase = 'idle';
      this.status(
        `${audio.durationSeconds.toFixed(1)} s · 16,000 Hz mono.${audio.warnings.length ? ' ' + audio.warnings.join(' ') : ''}`,
      );
      await this.transcribe();
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.recorder.discard();
      this.phase = 'idle';
      this.clearPreview();
      this.error(error);
      this.controls();
    }
  }

  private async transcribe(): Promise<void> {
    if (!this.audio || this.isBusy) return;
    const epoch = ++this.epoch;
    try {
      this.options.prepareRecording();
      this.phase = 'transcribing';
      this.status(
        'Loading local Whisper model. First use downloads model files; Cancel releases the worker.',
      );
      this.el('voice-retry').hidden = true;
      const progress = this.el<HTMLProgressElement>('voice-progress');
      progress.removeAttribute('value');
      this.controls();
      const transcript = await this.asr.transcribe(this.audio.slice(), (update) => {
        if (epoch !== this.epoch) return;
        const amount = update.total
          ? ` · ${((update.loaded ?? 0) / 1048576).toFixed(1)} / ${(update.total / 1048576).toFixed(1)} MiB`
          : '';
        this.status(
          update.message ??
            (update.status === 'ready'
              ? 'Model ready.'
              : update.status === 'transcribing'
                ? 'Transcribing locally…'
                : `Loading local model${update.file ? ' · ' + update.file : ''}${amount}`),
        );
        if (update.total && update.status === 'loading') {
          progress.max = update.total;
          progress.value = update.loaded ?? 0;
        } else progress.removeAttribute('value');
      });
      if (epoch !== this.epoch) return;
      this.transcript = transcript;
      this.text.value = transcript.text;
      this.el('voice-retry').hidden = !!transcript.text.trim();
      this.showTranscriptWarning(transcript.text);
      this.status(
        transcript.text.trim()
          ? 'Transcript ready. Correct scientific terms, then save locally.'
          : 'No speech recognized. Retry or type a note.',
      );
      this.text.focus();
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.clearPreview();
      this.el('voice-retry').hidden = false;
      this.error(error);
    } finally {
      if (epoch === this.epoch) {
        this.phase = 'idle';
        this.controls();
      }
    }
  }

  /** Cancelling terminates inference rather than claiming to interrupt an unsupported call. */
  cancel(announce = true): void {
    ++this.epoch;
    this.recorder.discard();
    this.asr.cancel();
    this.audio = undefined;
    this.clearPreview();
    this.phase = 'idle';
    this.el('voice-retry').hidden = true;
    if (announce)
      this.status('Voice task cancelled. Microphone and ASR worker released. You can type a note.');
    this.controls();
  }

  private draftNote(): VoiceNote {
    if (!this.locked) this.lockContext();
    return this.editing
      ? validateNote({
          ...this.editing,
          text: this.text.value.trim(),
          updatedAt: new Date().toISOString(),
        })
      : createNote(this.draftContext, this.text.value, this.transcript);
  }

  private async save(): Promise<void> {
    if (this.isBusy) return;
    try {
      const note = this.draftNote();
      this.phase = 'saving';
      this.controls();
      await this.store.put(note);
      this.editing = note;
      this.savedText = note.text;
      this.text.value = note.text;
      this.audio = undefined;
      this.clearPreview();
      this.el('voice-retry').hidden = true;
      await this.refresh();
      this.status('Saved locally. Export a JSON backup to keep a portable copy.');
    } catch (error) {
      this.error(error);
    } finally {
      this.phase = 'idle';
      this.controls();
    }
  }

  private async refresh(): Promise<void> {
    try {
      this.notes = await this.store.list();
      this.storageError = '';
      this.el('voice-count').textContent = `${this.notes.length} saved locally in this browser.`;
      this.options.onChange(this.notes);
      this.renderList();
    } catch (error) {
      this.storageError = error instanceof Error ? error.message : String(error);
      this.el('voice-count').textContent =
        'Local storage unavailable · drafts can still be exported.';
      throw error;
    }
  }

  private listedNotes(): VoiceNote[] {
    return this.all
      ? this.notes
      : this.notes.filter((note) =>
          note.selectedCellIds.some(
            (id) =>
              this.context.selectedCellIds.includes(id) &&
              associationKey(note, id) === associationKey(this.context, id),
          ),
        );
  }

  private renderList(): void {
    const list = this.el('voice-list'),
      notes = this.listedNotes();
    list.replaceChildren();
    this.button('voice-export').disabled = !notes.length;
    this.button('voice-scope').hidden = !this.context.selectedCellIds.length;
    this.button('voice-scope').textContent = this.all
      ? 'Show this cell only'
      : 'Show all saved notes';
    if (!notes.length) {
      list.textContent = 'No saved notes in this view.';
      return;
    }
    for (const note of notes) {
      const article = document.createElement('article');
      article.className = 'voice-saved-note';
      const info = document.createElement('p'),
        content = document.createElement('p'),
        actions = document.createElement('div');
      info.className = 'hint';
      info.textContent = `${new Date(note.updatedAt).toLocaleString()} · ${note.source === 'manual' ? 'Manual text' : 'Local Whisper'} · ${note.selectedCellIds.join(', ') || 'unattached'} · ${note.imageId ?? 'no image'}${note.labelSource ? ` · label source ${note.labelSource}` : ''}`;
      content.className = 'voice-note-text';
      content.textContent = note.text;
      actions.className = 'voice-actions';
      const edit = document.createElement('button'),
        remove = document.createElement('button'),
        exportOne = document.createElement('button');
      edit.className = 'secondary voice-edit';
      edit.textContent = 'Edit';
      edit.type = 'button';
      edit.onclick = () => {
        if (this.keepDraft()) return;
        this.resetDraft();
        this.editing = structuredClone(note);
        this.draftContext = structuredClone(note);
        this.locked = true;
        this.text.value = this.savedText = note.text;
        this.renderContext();
        this.controls();
        this.text.focus();
      };
      remove.className = 'secondary voice-delete';
      remove.textContent = 'Delete';
      remove.type = 'button';
      remove.onclick = async () => {
        if (this.isBusy || !window.confirm('Permanently delete this local note?')) return;
        this.phase = 'deleting';
        this.controls();
        try {
          await this.store.delete(note.id);
          if (this.editing?.id === note.id) this.resetDraft();
          await this.refresh();
          this.status('Local note deleted.');
        } catch (error) {
          this.error(error);
        } finally {
          this.phase = 'idle';
          this.controls();
        }
      };
      exportOne.className = 'secondary';
      exportOne.textContent = 'Export JSON';
      exportOne.type = 'button';
      exportOne.onclick = () => this.export([note], 'musivarium-note.json');
      edit.disabled = remove.disabled = this.isBusy;
      actions.append(edit, remove, exportOne);
      article.append(info, content, actions);
      list.append(article);
    }
  }

  private export(notes: VoiceNote[], filename: string): void {
    download(new TextEncoder().encode(exportNotes(notes)), filename, 'application/json');
  }
}
