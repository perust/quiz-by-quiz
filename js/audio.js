// 효과음 (3-B)
//
// 오디오 파일 없이 Web Audio API로 짧은 소리를 그때그때 합성한다.
// 외부 라이브러리도, 저장소에 넣을 바이너리 에셋도 쓰지 않는다는 제약을 지키기 위함이다.
//
// 소리를 켜고 끄는 값은 이 파일이 갖지 않는다. app.js가 저장소에서 읽어 setEnabled로 넘긴다.

/** @type {AudioContext|null} */
let context = null;
let enabled = true;

/**
 * 브라우저는 사용자 조작 없이 소리를 내지 못하게 막는다.
 * 그래서 컨텍스트를 미리 만들지 않고 첫 재생 시점에 만든다.
 */
function getContext() {
  if (context) return context;

  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;

  try {
    context = new Ctor();
  } catch {
    context = null; // 소리를 못 내도 게임은 그대로 돌아간다
  }
  return context;
}

/**
 * 짧은 음 하나. 시작할 때 살짝 올리고 끝에서 줄여 딸깍거리는 잡음을 없앤다.
 *
 * @param {{ freq: number, delay?: number, duration?: number, type?: OscillatorType, peak?: number }} params
 */
function beep({ freq, delay = 0, duration = 0.12, type = 'sine', peak = 0.07 }) {
  const ctx = getContext();
  if (!ctx) return;

  if (ctx.state === 'suspended') ctx.resume();

  const at = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);

  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + duration + 0.02);
}

/** 소리를 낼지 말지. localStorage 저장은 app.js와 storage/ 가 맡는다 */
export function setEnabled(value) {
  enabled = Boolean(value);
}

export function isEnabled() {
  return enabled;
}

/** 정답 — 두 음이 올라간다 */
export function playCorrect() {
  if (!enabled) return;
  beep({ freq: 659.25, duration: 0.1 });
  beep({ freq: 987.77, delay: 0.09, duration: 0.16 });
}

/** 오답 — 낮은 음이 짧게 두 번 */
export function playWrong() {
  if (!enabled) return;
  beep({ freq: 233.08, duration: 0.11, type: 'triangle', peak: 0.06 });
  beep({ freq: 174.61, delay: 0.1, duration: 0.18, type: 'triangle', peak: 0.06 });
}

/** 시간 초과 — 오답과 구분되게 한 음이 길게 떨어진다 */
export function playTimeout() {
  if (!enabled) return;
  beep({ freq: 392, duration: 0.14, type: 'sawtooth', peak: 0.045 });
  beep({ freq: 196, delay: 0.13, duration: 0.26, type: 'sawtooth', peak: 0.045 });
}
