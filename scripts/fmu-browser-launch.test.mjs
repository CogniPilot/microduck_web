import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedLaunchConfig,qualificationBrowserEnvironment,qualificationFontConfig} from './fmu-browser-launch.mjs';
const config=()=>({schema:'fmu-browser-qualification-launch/1',playwrightEntry:'/tools/playwright/index.mjs',
 playwrightEntrySha256:'a'.repeat(64),executable:'/browser/chrome',expectedVersion:'158.0.8127.18',
 scratch:'/tmp/qualification-fresh',libraryDirectories:['/browser','/libraries'],fontDirectory:'/fonts',coreutilsBin:'/tools/bin'});

test('explicit child environment cannot inherit loader, proxy or Node configuration',()=>{
 const c=checkedLaunchConfig(config()),e=qualificationBrowserEnvironment(c,c.scratch+'/fonts.conf');
 assert.deepEqual(Object.keys(e).sort(),['PATH','HOME','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME',
  'LANG','LC_ALL','FONTCONFIG_FILE','LD_LIBRARY_PATH'].sort());
 assert.equal(e.LD_LIBRARY_PATH,'/browser:/libraries');
 assert.equal(e.FONTCONFIG_FILE,'/tmp/qualification-fresh/fonts.conf');
 assert.equal(e.HOME,'/tmp/qualification-fresh/home');
 assert(!Object.hasOwn(e,'NODE_OPTIONS'));assert(!Object.hasOwn(e,'LD_PRELOAD'));assert(!Object.hasOwn(e,'HTTPS_PROXY'));
});
test('bad identity, paths, provider hash or search ordering refuse before any launch',()=>{
 for(const change of [{schema:'other'},{scratch:'/tmp/../used'},{executable:'relative'},
  {playwrightEntrySha256:'unknown'},{expectedVersion:'unknown'},
  {libraryDirectories:['/libraries','/browser']},{libraryDirectories:['/browser','/browser']},
  {libraryDirectories:['/browser','/a:b']},{NODE_OPTIONS:'--import bad'}])
  assert.throws(()=>checkedLaunchConfig({...config(),...change}));
 const c=config(),copy=checkedLaunchConfig(c);c.libraryDirectories.push('/later');
 assert.deepEqual(copy.libraryDirectories,['/browser','/libraries']);
});
test('font configuration escapes path text and uses the private scratch cache',()=>{
 const c=checkedLaunchConfig({...config(),fontDirectory:'/fonts/a&b',scratch:'/tmp/a<b'});
 assert.match(qualificationFontConfig(c),/<dir>\/fonts\/a&amp;b<\/dir>/);
 assert.match(qualificationFontConfig(c),/<cachedir>\/tmp\/a&lt;b\/fontconfig-cache<\/cachedir>/);
});
