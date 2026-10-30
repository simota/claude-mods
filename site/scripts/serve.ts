import { existsSync, watch } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(scriptDir, '..');
const distDir = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : join(siteRoot, 'dist');
const port = Number(process.env.PORT ?? '4173');
const watchMode = process.argv.includes('--watch');

function runBuild(): number {
  const proc = Bun.spawnSync(['bun', 'run', join(siteRoot, 'scripts', 'build.ts')], {
    cwd: siteRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return proc.exitCode;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

if (watchMode || !existsSync(join(distDir, 'index.html'))) {
  const code = runBuild();
  if (code !== 0) process.exit(code);
}

if (watchMode) {
  let debounce: ReturnType<typeof setTimeout> | null = null;
  watch(join(siteRoot, 'src'), { recursive: true }, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      runBuild();
    }, 120);
  });
}

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    const reqPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const safePath = normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = resolve(distDir, `.${safePath}`);
    if (!fullPath.startsWith(distDir) || !existsSync(fullPath)) {
      return new Response('Not Found', { status: 404 });
    }
    const ext = extname(fullPath).toLowerCase();
    const contentType = MIME[ext] ?? 'application/octet-stream';
    const file = Bun.file(fullPath);
    const rangeHeader = req.headers.get('range');

    if (rangeHeader && file.size > 0) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (match) {
        const total = file.size;
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
        if (start >= 0 && start <= end && start < total) {
          return new Response(file.slice(start, end + 1), {
            status: 206,
            headers: {
              'Content-Type': contentType,
              'Accept-Ranges': 'bytes',
              'Content-Range': `bytes ${start}-${end}/${total}`,
              'Content-Length': String(end - start + 1),
              'Cache-Control': 'no-cache',
            },
          });
        }
      }
    }

    return new Response(file, {
      headers: {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      },
    });
  },
});

console.log(`claude-mods LP serving at http://localhost:${server.port}`);
