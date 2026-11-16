import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import {createSoundtrack, MUSIC_KEY} from '../site/soundtrack.js';

function fixture({stored = null, refuse = false} = {}) {
  const log = [], listeners = {}, docListeners = {};
  const audio = {
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
  const soundtrack = createSoundtrack({audio, button, storage, document: doc});
  const setHidden = hidden => { doc.hidden = hidden; docListeners.visibilitychange(); };
  return {log, button, data, soundtrack, setHidden};
}

test('music is on by default and starts only with Waddle in', () => {
  const f = fixture();
  assert.equal(f.button.textContent, 'Music on');
  assert.equal(f.button.attributes['aria-pressed'], 'true');
  assert.deepEqual(f.log, []);
  f.soundtrack.start();
  assert.deepEqual(f.log, ['play']);
});

test('the button turns it off and on, and the choice is remembered', () => {
  const f = fixture();
  f.soundtrack.start();
  f.button.click();
  assert.equal(f.button.textContent, 'Music off');
  assert.equal(f.data.get(MUSIC_KEY), 'off');
  assert.deepEqual(f.log, ['play', 'pause']);
  f.button.click();
  assert.equal(f.data.get(MUSIC_KEY), 'on');
  assert.deepEqual(f.log, ['play', 'pause', 'play']);
});

test('a visitor who turned it off is not played at Waddle in', () => {
  const f = fixture({stored: 'off'});
  assert.equal(f.button.textContent, 'Music off');
  f.soundtrack.start();
  assert.deepEqual(f.log, []);
});

test('a hidden tab is silent and resumes when visible again', () => {
  const f = fixture();
  f.soundtrack.start();
  f.setHidden(true);
  f.setHidden(false);
  assert.deepEqual(f.log, ['play', 'pause', 'play']);
  f.button.click();
  f.setHidden(true);
  f.setHidden(false);
  assert.deepEqual(f.log, ['play', 'pause', 'play', 'pause', 'pause']);
});

test('a refused play or unavailable storage leaves the page working', async () => {
  const f = fixture({refuse: true});
  f.soundtrack.start();
  await new Promise(resolve => setImmediate(resolve));
  const blocked = createSoundtrack({audio: {play: () => Promise.resolve(), pause() {}},
    button: {setAttribute() {}, addEventListener() {}},
    storage: {getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }}, document: null});
  assert.equal(blocked.enabled(), true);
});

test('the page ships the credited recording', () => {
  const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.match(html, /<audio id="soundtrack" src="\.\/audio\/also-sprach-zarathustra\.mp3" loop preload="none"><\/audio>/);
  assert.match(html, /<button id="music-toggle"/);
  assert.ok(statSync(new URL('../site/audio/also-sprach-zarathustra.mp3', import.meta.url)).size > 1e6);
  const notice = readFileSync(new URL('../site/audio/NOTICE', import.meta.url), 'utf8');
  assert.match(notice, /CC BY 3\.0/);
  assert.match(notice, /Philip Milman/);
  assert.match(readFileSync(new URL('../site/pollen/NOTICE', import.meta.url), 'utf8'), /\.\.\/audio\/NOTICE/);
});
