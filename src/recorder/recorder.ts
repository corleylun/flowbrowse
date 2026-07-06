import { RecordedAction } from './actions';

export interface RecorderState {
  recording: boolean;
  count: number;
}

export type RecorderListener = (state: RecorderState) => void;

/**
 * A local, user-owned recording buffer. Actions are appended only while recording is
 * ON; the user can pause (stop) and clear at any time, and the buffer never leaves the
 * machine until the user explicitly saves it as a recipe. Recording is a SEPARATE switch
 * from AI visibility — capturing your actions does not grant the AI anything.
 */
const MAX_BUFFER = 10_000; // cap a recording so a runaway page can't balloon memory

export class Recorder {
  private recording = false;
  private buffer: RecordedAction[] = [];
  private readonly listeners = new Set<RecorderListener>();

  start(): void {
    this.recording = true;
    this.emit();
  }

  /** Pause recording (keeps the buffer). */
  stop(): void {
    this.recording = false;
    this.emit();
  }

  /** Wipe the buffer — the captured actions are gone, never shared. */
  clear(): void {
    this.buffer = [];
    this.emit();
  }

  isRecording(): boolean {
    return this.recording;
  }

  /** Append an action — ignored unless recording is active; capped at MAX_BUFFER. */
  add(action: RecordedAction): void {
    if (!this.recording) return;
    if (this.buffer.length >= MAX_BUFFER) return;
    this.buffer.push(action);
    this.emit();
  }

  actions(): RecordedAction[] {
    return [...this.buffer];
  }

  count(): number {
    return this.buffer.length;
  }

  state(): RecorderState {
    return { recording: this.recording, count: this.buffer.length };
  }

  onChange(listener: RecorderListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const s = this.state();
    for (const l of this.listeners) {
      try {
        l(s);
      } catch {
        /* a listener must never break the recorder */
      }
    }
  }
}
