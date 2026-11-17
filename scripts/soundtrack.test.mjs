import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import {createSoundtrack, MUSIC_KEY, MUSIC_VOLUME} from '../site/soundtrack.js';

const SRC = './audio/also-sprach-zarathustra.mp3';

function fixture({stored = null, refuse = false} = {}) {
  const log = [], listeners = {}, docListeners = {};
  const sources = [];
  const audio = {
    volume: 1,
    set src(value) { sources.push(value); log.push('src'); },
    play() { log.push('play'); return refuse ? Promise.reject(Error('NotAllowedError')) : Promise.resolve(); },
    pause() { log.push('pause'); }
  };
  const button = {
    textContent: '', attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, handler) { listeners[type] = handler; },
    click() { listeners.click(); }
  };
  const data = new Map(stored === null ? [] : [[MUSIC_KEY, stored]]);
  const storage = {getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value)};
  const doc = {hidden: false, addEventListener(type, handler) { docListeners[type] = handler; }};
  const soundtrack = createSoundtrack({audio, src: SRC, button, storage, document: doc});
  const setHidden = hidden => { doc.hidden = hidden; docListeners.visibilitychange(); };
  return {log, sources, audio, button, data, soundtrack, setHidden};
}

test('a new visitor hears nothing and downloads nothing until they turn Dramatic Music on', () => {
  const f = fixture();
  assert.equal(f.button.textContent, 'Dramatic Music: off');
  assert.equal(f.button.attributes['aria-pressed'], 'false');
  f.soundtrack.start();
  assert.deepEqual(f.log, []);
  assert.deepEqual(f.sources, []);
  f.button.click();
  assert.equal(f.button.textContent, 'Dramatic Music: on');
  assert.equal(f.data.get(MUSIC_KEY), 'on');
  assert.deepEqual(f.log, ['src', 'play']);
});

test('a visitor who turned it on hears it at a modest volume from Waddle in', () => {
  const f = fixture({stored: 'on'});
  assert.equal(f.audio.volume, MUSIC_VOLUME);
  assert.ok(MUSIC_VOLUME > 0 && MUSIC_VOLUME < 1);
  assert.equal(f.button.textContent, 'Dramatic Music: on');
  assert.equal(f.button.attributes['aria-pressed'], 'true');
  assert.deepEqual(f.log, []);
  f.soundtrack.start();
  assert.deepEqual(f.log, ['src', 'play']);
  assert.deepEqual(f.sources, [SRC]);
});

test('the button turns it off and on, and the choice is remembered', () => {
  const f = fixture({stored: 'on'});
  f.soundtrack.start();
  f.button.click();
  assert.equal(f.button.textContent, 'Dramatic Music: off');
  assert.equal(f.data.get(MUSIC_KEY), 'off');
  assert.deepEqual(f.log, ['src', 'play', 'pause']);
  f.button.click();
  assert.equal(f.data.get(MUSIC_KEY), 'on');
  // The recording is assigned once; turning it back on only plays.
  assert.deepEqual(f.log, ['src', 'play', 'pause', 'play']);
});

test('a visitor who turned it off is not played or downloaded at Waddle in', () => {
  const f = fixture({stored: 'off'});
  assert.equal(f.button.textContent, 'Dramatic Music: off');
  f.soundtrack.start();
  assert.deepEqual(f.log, []);
  assert.deepEqual(f.sources, [], 'a remembered off never assigns the recording, so it is never downloaded');
  f.button.click();
  assert.deepEqual(f.log, ['src', 'play']);
  assert.deepEqual(f.sources, [SRC]);
});

test('a hidden tab is silent and resumes when visible again', () => {
  const f = fixture({stored: 'on'});
  f.soundtrack.start();
  f.setHidden(true);
  f.setHidden(false);
  assert.deepEqual(f.log, ['src', 'play', 'pause', 'play']);
  f.button.click();
  f.setHidden(true);
  f.setHidden(false);
  assert.deepEqual(f.log, ['src', 'play', 'pause', 'play', 'pause', 'pause']);
});

test('a refused play or unavailable storage leaves the page working', async () => {
  const f = fixture({stored: 'on', refuse: true});
  f.soundtrack.start();
  await new Promise(resolve => setImmediate(resolve));
  // The button shows the preference, not a claim that the refused play is sounding.
  assert.equal(f.button.textContent, 'Dramatic Music: on');
  const blocked = createSoundtrack({audio: {play: () => Promise.resolve(), pause() {}}, src: SRC,
    button: {setAttribute() {}, addEventListener() {}},
    storage: {getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }}, document: null});
  assert.equal(blocked.enabled(), false, 'unreadable storage falls back to the default: off');
});

test('the page ships the credited recording', () => {
  const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  // No src in the markup: the URL is assigned only by an enabled, user-triggered play.
  assert.match(html, /<audio id="soundtrack" data-src="\.\/audio\/also-sprach-zarathustra\.mp3" loop preload="none"><\/audio>/);
  assert.doesNotMatch(html, /<audio[^>]* src=/);
  assert.match(html, /<button id="music-toggle" aria-pressed="false"[^>]*>Dramatic Music: off<\/button>/);
  assert.ok(statSync(new URL('../site/audio/also-sprach-zarathustra.mp3', import.meta.url)).size > 1e6);
  const notice = readFileSync(new URL('../site/audio/NOTICE', import.meta.url), 'utf8');
  assert.match(notice, /CC BY 3\.0/);
  assert.match(notice, /Philip Milman/);
  assert.match(readFileSync(new URL('../site/pollen/NOTICE', import.meta.url), 'utf8'), /\.\.\/audio\/NOTICE/);
});
