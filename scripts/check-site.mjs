import {readdir, stat, readFile} from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'site');
for (const name of ['index.html', 'app.js', 'physics.worker.js', 'policy-contract.js',
  'walking-controls.js', 'sources/manifest.json', 'policies/velstand.onnx']) {
  if (!(await stat(path.join(root, name))).isFile()) throw Error(`Missing site file: ${name}`);
}
let bytes = 0, count = 0;
async function walk(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error(`Pages cannot publish a symlink: ${file}`);
    if (entry.isDirectory()) await walk(file);
    else if (entry.isFile()) {
      const size = (await stat(file)).size;
      if (size >= 100 * 1024 * 1024) throw Error(`File exceeds GitHub's 100 MiB limit: ${file}`);
      count++; bytes += size;
    } else throw Error(`Unexpected site entry: ${file}`);
  }
}
await walk(root);
const html = await readFile(path.join(root, 'index.html'), 'utf8');
if (/(?:src|href)=["']\/(?!\/)/.test(html)) throw Error('Root-absolute index URL breaks project Pages.');
console.log(JSON.stringify({site_files: count, site_bytes: bytes, root}));
