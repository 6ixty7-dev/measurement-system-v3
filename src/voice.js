// ─── Voice Module ─────────────────────────────────────────────────────────────
// All spoken guidance comes from Gemini — no hardcoded strings for guidance.
// Only truly static UI text (button labels etc.) is hardcoded.

let currentLang = 'en';
let isBusy = false;
let queue = [];

export function setLang(l) { currentLang = l; }
export function getLang() { return currentLang; }

// Speak any text aloud using browser TTS
export function speak(text, interrupt = false) {
  if (!window.speechSynthesis) return;
  if (interrupt) {
    window.speechSynthesis.cancel();
    queue = [];
    isBusy = false;
  }
  queue.push(text);
  if (!isBusy) _next();
}

function _next() {
  if (!queue.length) { isBusy = false; return; }
  isBusy = true;
  const text = queue.shift();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang  = currentLang === 'ml' ? 'ml-IN' : 'en-IN';
  utt.rate  = 0.9;
  utt.pitch = 1.0;
  utt.volume = 1.0;
  const voices = window.speechSynthesis.getVoices();
  const pick = voices.find(v =>
    currentLang === 'ml' ? v.lang.startsWith('ml') : v.lang.startsWith('en-IN')
  ) || voices.find(v => v.lang.startsWith('en'));
  if (pick) utt.voice = pick;
  utt.onend = utt.onerror = () => setTimeout(_next, 100);
  window.speechSynthesis.speak(utt);
}

export function stopSpeaking() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  queue = [];
  isBusy = false;
}
