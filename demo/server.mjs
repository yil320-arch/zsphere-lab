import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const demoDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(demoDirectory, '..');
const port = Number.parseInt(process.env.DEMO_PORT ?? '4173', 10);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8'
};

function safeResolve(root, requestPath) {
  const target = resolve(root, `.${requestPath}`);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return null;
  return target;
}

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filePath = pathname === '/' || pathname === ''
      ? resolve(demoDirectory, 'zsphere-lab.html')
      : safeResolve(projectRoot, pathname);

    if (!filePath) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file');

    response.writeHead(200, {
      'Cache-Control': 'no-cache',
      'Content-Length': info.size,
      'Content-Type': mimeTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`ZSphere lab: http://127.0.0.1:${port}/`);
});
