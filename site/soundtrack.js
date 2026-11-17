// Background soundtrack (Strauss, Also sprach Zarathustra; CC BY 3.0, see audio/NOTICE).
// It is off by default. The Dramatic Music button turns it on and off; the choice is
// remembered in this browser, so a visitor who turned it on hears it from the next Waddle in
// (browsers start sound only from a click), and a hidden tab is silent. The
// recording's URL is assigned only when it is first played, so a visitor who keeps the
// music off never downloads it (preload=none is only a hint to the browser). The button
// shows the preference; it does not claim that a refused play is sounding.
export const MUSIC_KEY = 'microduck-music';
// Background level: present but quieter than the page's own sounds and speech.
export const MUSIC_VOLUME = 0.4;

export function createSoundtrack({audio, src, button, storage, document: doc = globalThis.document}) {
  const read = () => { try { return storage.getItem(MUSIC_KEY); } catch { return null; } };
  const write = value => { try { storage.setItem(MUSIC_KEY, value); } catch {} };
  let enabled = read() === 'on', entered = false, assigned = false;
  audio.volume = MUSIC_VOLUME;
  const show = () => {
    button.textContent = enabled ? 'Dramatic Music: on' : 'Dramatic Music: off';
    button.setAttribute('aria-pressed', String(enabled));
  };
  // A refused play (no user activation yet, or no audio output) leaves the page as it was.
  const play = () => {
    if (!enabled || !entered || doc?.hidden) return;
    if (!assigned) { audio.src = src; assigned = true; }
    audio.play()?.catch?.(() => {});
  };
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
