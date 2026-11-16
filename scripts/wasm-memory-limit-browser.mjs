// How many wasm instances, each defining one memory, can one Chromium worker hold?
// usage: node wasm-memory-limit.mjs <playwright-core index.mjs> <chromium> [pages] [max]
const [entry, executable, pagesArg = '1', maxArg = '400'] = process.argv.slice(2);
const {chromium} = await import(entry);
const browser = await chromium.launch({executablePath: executable, args: ['--no-sandbox']});
try {
  const page = await browser.newPage();
  await page.goto('about:blank');
  const result = await page.evaluate(async ({pages, max}) => {
    // (module (memory (export "m") <pages>))
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 0, pages, 7, 5, 1, 1, 109, 2, 0]);
    const source = `self.onmessage=async e=>{const m=await WebAssembly.compile(e.data.bytes);const keep=[];
      for(let i=0;i<e.data.max;i++){try{keep.push(await WebAssembly.instantiate(m));}
      catch(error){self.postMessage({count:i,error:String(error)});return;}}self.postMessage({count:e.data.max});};`;
    const worker = new Worker(URL.createObjectURL(new Blob([source], {type: 'text/javascript'})));
    return await new Promise(resolve => { worker.onmessage = e => resolve(e.data); worker.postMessage({bytes, max}); });
  }, {pages: Number(pagesArg), max: Number(maxArg)});
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
