import {readdir, stat, readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const root = path.resolve(process.argv[2] ?? 'site');
for (const name of ['index.html', 'app.js', 'physics.worker.js', 'walk-runner.js', 'policy-contract.js',
  'walking-controls.js', 'sources/manifest.json', 'policies/velstand.onnx']) {
  if (!(await stat(path.join(root, name))).isFile()) throw Error(`Missing site file: ${name}`);
}
let bytes = 0, count = 0;
const meshes = new Map();
async function walk(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error(`Pages cannot publish a symlink: ${file}`);
    if (entry.isDirectory()) await walk(file);
    else if (entry.isFile()) {
      const size = (await stat(file)).size;
      if (size >= 100 * 1024 * 1024) throw Error(`File exceeds GitHub's 100 MiB limit: ${file}`);
      count++; bytes += size;
      if (/\.stl$/i.test(entry.name)) meshes.set(path.relative(root, file).split(path.sep).join('/'),
        createHash('sha256').update(await readFile(file)).digest('hex'));
    } else throw Error(`Unexpected site entry: ${file}`);
  }
}
await walk(root);
if (meshes.size) {
  let clearance;
  try {clearance = JSON.parse(await readFile('mesh-clearance.json', 'utf8'));}
  catch {throw Error('STL assets require a valid owner-approved mesh-clearance.json at the repository root.');}
  if (clearance?.schema_version !== 1 || typeof clearance.decision !== 'string' ||
      !clearance.decision.trim() || !clearance.files || Array.isArray(clearance.files) ||
      typeof clearance.files !== 'object') throw Error('Invalid mesh clearance record.');
  const names = Object.keys(clearance.files);
  if (names.length !== meshes.size || names.some(name => !meshes.has(name)))
    throw Error('Mesh clearance must list exactly the STL assets being published.');
  for (const [name, hash] of meshes)
    if (clearance.files[name] !== hash) throw Error(`Mesh clearance hash mismatch: ${name}`);
}
const html = await readFile(path.join(root, 'index.html'), 'utf8');
if (/(?:src|href)=["']\/(?!\/)/.test(html)) throw Error('Root-absolute index URL breaks project Pages.');
console.log(JSON.stringify({site_files: count, site_bytes: bytes, cleared_meshes:meshes.size, root}));
