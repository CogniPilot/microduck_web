// Qualification tooling only. The operator must pin this config, the provider tree and
// the retained executable/libraries before invoking it. This file issues no admission.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const fields=['schema','playwrightEntry','playwrightEntrySha256','executable','expectedVersion',
 'scratch','libraryDirectories','fontDirectory','coreutilsBin'];
const absolute=value=>typeof value==='string'&&path.isAbsolute(value)&&path.resolve(value)===value&&
 !/[\0\r\n:]/.test(value);
const xml=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');

export function checkedLaunchConfig(config){
 assert(config&&typeof config==='object'&&!Array.isArray(config),'invalid launch config');
 assert.equal(config.schema,'fmu-browser-qualification-launch/1');
 assert.deepEqual(Object.keys(config).sort(),[...fields].sort(),'unexpected launch config fields');
 for(const name of ['playwrightEntry','executable','scratch','fontDirectory','coreutilsBin'])
  assert(absolute(config[name]),'noncanonical launch path: '+name);
 assert(/^[a-f0-9]{64}$/.test(config.playwrightEntrySha256),'missing provider entry hash');
 assert(/^[0-9]+(?:\.[0-9]+){3}$/.test(config.expectedVersion),'missing expected browser version');
 assert(Array.isArray(config.libraryDirectories)&&config.libraryDirectories.length>0&&
  config.libraryDirectories.every(absolute)&&new Set(config.libraryDirectories).size===config.libraryDirectories.length,
  'invalid library search path');
 assert.equal(config.libraryDirectories[0],path.dirname(config.executable),'bundle must lead library search path');
 return {...config,libraryDirectories:[...config.libraryDirectories]};
}

export function qualificationBrowserEnvironment(config,fontconfig){
 assert(absolute(fontconfig),'noncanonical font configuration');
 return {PATH:config.coreutilsBin,HOME:config.scratch+'/home',TMPDIR:config.scratch+'/tmp',
  XDG_CONFIG_HOME:config.scratch+'/home/.config',XDG_CACHE_HOME:config.scratch+'/home/.cache',
  LANG:'C.UTF-8',LC_ALL:'C.UTF-8',FONTCONFIG_FILE:fontconfig,
  LD_LIBRARY_PATH:config.libraryDirectories.join(':')};
}

export function qualificationFontConfig(config){
 return `<?xml version="1.0"?>\n<fontconfig>\n  <dir>${xml(config.fontDirectory)}</dir>\n`+
  `  <cachedir>${xml(config.scratch)}/fontconfig-cache</cachedir>\n</fontconfig>\n`;
}

// The optional config selects the already qualified provider/browser and gives only
// the browser child its library/font environment. Default local developer use keeps
// the existing Playwright resolution and arguments.
export async function launchSmokeBrowser(configPath){
 if(!configPath){
  const {chromium}=await import('playwright');
  return chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE,
   args:['--no-sandbox','--enable-unsafe-swiftshader']});
 }
 const config=checkedLaunchConfig(JSON.parse(await readFile(configPath)));
 const entryBytes=await readFile(config.playwrightEntry);
 assert.equal(createHash('sha256').update(entryBytes).digest('hex'),config.playwrightEntrySha256,
  'provider entry differs from the pinned launch config');
 // Exclusive scratch identity: a consumed qualification is never silently resumed.
 await mkdir(config.scratch);
 for(const suffix of ['/home','/home/.config','/home/.cache','/tmp'])await mkdir(config.scratch+suffix);
 const fontconfig=config.scratch+'/fonts.conf';
 await writeFile(fontconfig,qualificationFontConfig(config),{flag:'wx'});
 process.env.HOME=config.scratch+'/home';process.env.TMPDIR=config.scratch+'/tmp';
 const {chromium}=await import(pathToFileURL(config.playwrightEntry).href);
 const browser=await chromium.launch({executablePath:config.executable,headless:true,
  args:['--no-sandbox','--enable-unsafe-swiftshader','--host-resolver-rules=MAP * ~NOTFOUND'],
  env:qualificationBrowserEnvironment(config,fontconfig),timeout:60000,
  handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false});
 try{assert.equal(browser.version(),config.expectedVersion,'unexpected qualified browser version');}
 catch(error){await browser.close();throw error;}
 return browser;
}
