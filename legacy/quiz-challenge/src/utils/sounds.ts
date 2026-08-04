let audioCtx: AudioContext | null = null;
let muted = false;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

function playTone(
  frequency: number,
  duration: number,
  type: OscillatorType = 'sine',
  startTime?: number
): void {
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(frequency, ctx.currentTime);
  gain.gain.setValueAtTime(0.15, ctx.currentTime);

  const start = startTime ?? ctx.currentTime;
  gain.gain.exponentialRampToValueAtTime(0.001, start + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration);
}

export function playCorrectSound(): void {
  if (muted) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  playTone(523.25, 0.1, 'sine', now);       // C5
  playTone(659.25, 0.15, 'sine', now + 0.1); // E5
}

export function playWrongSound(): void {
  if (muted) return;
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'square';
  osc.frequency.setValueAtTime(150, ctx.currentTime);
  osc.frequency.linearRampToValueAtTime(100, ctx.currentTime + 0.3);
  gain.gain.setValueAtTime(0.1, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.3);
}

export function playFanfareSound(): void {
  if (muted) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  playTone(523.25, 0.2, 'sine', now);        // C5
  playTone(659.25, 0.2, 'sine', now + 0.2);  // E5
  playTone(783.99, 0.3, 'sine', now + 0.4);  // G5
}

export function setMuted(value: boolean): void {
  muted = value;
}

export function isSoundMuted(): boolean {
  return muted;
}
