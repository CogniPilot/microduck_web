// Background soundtrack (Strauss, Also sprach Zarathustra; CC BY 3.0, see audio/NOTICE).
// Browsers start sound only from a click, so it begins on Waddle in. The button turns it
// off and on, the choice is remembered in this browser, and a hidden tab is silent.
export const MUSIC_KEY = 'microduck-music';

export function createSoundtrack({audio, button, storage, document: doc = globalThis.document}) {
  const read = () => { try { return storage.getItem(MUSIC_KEY); } catch { return null; } };
  const write = value => { try { storage.setItem(MUSIC_KEY, value); } catch {} };
  let enabled = read() !== 'off', entered = false;
  const show = () => {
    button.textContent = enabled ? 'Music on' : 'Music off';
    button.setAttribute('aria-pressed', String(enabled));
  };
  // A refused play (no user activation yet, or no audio output) leaves the page as it was.
  const play = () => { if (enabled && entered && !doc?.hidden) audio.play()?.catch?.(() => {}); };
  button.addEventListener('click', () => {
    enabled = !enabled;
    write(enabled ? 'on' : 'off');
    show();
    if (enabled) { entered = true; play(); } else audio.pause();
  });
  doc?.addEventListener?.('visibilitychange', () => { if (doc.hidden) audio.pause(); else play(); });
  show();
  return {
    // Called from the Waddle in click, inside its user activation.
    start() { entered = true; play(); },
    enabled: () => enabled
  };
}
