import http from 'node:http';
import {createReadStream} from 'node:fs';
import {realpath, stat} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// A project Pages prefix, with no cross-origin isolation headers.
export async function serve(root, port = 0) {
  root = await realpath(root);
  const prefix = '/microduck-demo/';
  const types = {'.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
    '.css':'text/css', '.json':'application/json', '.wasm':'application/wasm',
    '.xml':'application/xml', '.svg':'image/svg+xml', '.png':'image/png'};
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (!['GET', 'HEAD'].includes(request.method) || !url.pathname.startsWith(prefix)) {
        response.writeHead(404); response.end(); return;
      }
      const relative = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html';
      const file = await realpath(path.resolve(root, relative));
      if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) {
        response.writeHead(404); response.end(); return;
      }
      response.writeHead(200, {'content-type':types[path.extname(file)] ?? 'application/octet-stream'});
      if (request.method === 'HEAD') response.end();
      else createReadStream(file).on('error', () => response.destroy()).pipe(response);
    } catch {response.writeHead(404); response.end();}
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {server, url:`http://127.0.0.1:${server.address().port}${prefix}`};
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const {server, url} = await serve(path.resolve(process.argv[2] ?? 'site'), 8080);
  console.log(url);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
