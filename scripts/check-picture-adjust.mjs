#!/usr/bin/env node
/*
 * Runs the website's Process engine (src/pictureAdjust/) for real and holds it to the app's recipe.
 *
 *   npm run check:picture-adjust [-- --software-gl | --no-worker | --keep]
 *
 * WHY A BROWSER. The engine draws with WebGL in a worker: nothing under Node's test runner goes through
 * it. And it is the one place the recipe's shaders — copied from the app (npm run sync:lab-core), where
 * they run on the phone's own graphics backend — meet WebGL's compiler. So this builds the site as it is
 * deployed, serves the built worker and CanvasKit's wasm beside a page that drives the engine through the
 * site's own client code (scripts/check-picture-adjust.page.ts says what it checks), and opens that page
 * in headless Chrome. RUN IT AFTER A SYNC THAT CHANGED src/pictureAdjust/core/, and after touching the
 * engine.
 *
 * Needs a Chrome on this machine (CHROME_PATH, or one of the usual places). Nothing is deployed, signed
 * in to, or fetched from the network: the build goes to a temporary folder (kept with --keep) and the
 * page is served on 127.0.0.1.
 *
 *   --software-gl   Chrome's software WebGL (SwiftShader): what a machine without a graphics card runs.
 *   --no-worker     the page has no Worker: the engine's own-thread path.
 *
 * The timings printed at the end are this machine's, headless: a guide to the order of things, not what
 * a visitor's browser does.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
// (Vite's own bundler: in node_modules wherever Vite is.)
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const flags = new Set(process.argv.slice(2));

const chromePath = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p) => p && existsSync(p));
if (!chromePath) {
  console.error('check-picture-adjust: no Chrome found; set CHROME_PATH to one');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'check-picture-adjust-'));
const dist = join(work, 'dist');
const profile = join(work, 'chrome');
let chrome = null;
const finish = (code) => {
  try {
    chrome?.kill();
  } catch {
    // Gone already.
  }
  // (Chrome lets go of its profile a moment after it is killed.)
  setTimeout(() => {
    if (flags.has('--keep')) console.log(`kept ${work}`);
    else rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    process.exit(code);
  }, 600);
};

// ---- the site as it is deployed: its worker and the wasm it fetches
console.log('building the site…');
const built = spawnSync(
  process.execPath,
  [join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', dist, '--logLevel', 'error'],
  { cwd: webRoot, stdio: 'inherit' },
);
if (built.status !== 0) {
  console.error('check-picture-adjust: the build failed');
  finish(1);
} else {
  const assets = join(dist, 'assets');
  const names = readdirSync(assets);
  const workerFile = names.find((n) => /^adjustFrame\.worker-.*\.js$/.test(n));
  const wasmFile = names.find((n) => /^canvaskit-.*\.wasm$/.test(n));
  if (!workerFile || !wasmFile) {
    console.error('check-picture-adjust: the build has no adjustFrame worker or no CanvasKit wasm');
    finish(1);
  } else {
    await run(assets, names, workerFile, wasmFile);
  }
}

async function run(assets, names, workerFile, wasmFile) {
  // ---- the page: the site's own client code, bundled as it stands. Two things Vite does for the site
  // are done by hand: the wasm's `?url` import, and (below, by the server) the worker's address.
  const page = await build({
    entryPoints: [join(here, 'check-picture-adjust.page.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['fs', 'path'],
    logLevel: 'error',
    plugins: [
      {
        name: 'wasm-url',
        setup(b) {
          b.onResolve({ filter: /\.wasm\?url$/ }, () => ({ path: 'wasm-url', namespace: 'wasm-url' }));
          b.onLoad({ filter: /.*/, namespace: 'wasm-url' }, () => ({
            contents: `export default ${JSON.stringify(`/assets/${wasmFile}`)};`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  const pageJs = page.outputFiles[0].text;
  const html = `<!doctype html><meta charset=utf-8>
<script>
window.onerror = (m) => fetch('/log', { method: 'POST', body: 'page error: ' + m });
${flags.has('--no-worker') ? 'window.Worker = undefined;' : ''}
</script>
<script type=module src=/page.js></script>`;

  const bodyOf = (req) =>
    new Promise((done) => {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => done(text));
    });
  const server = createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    if (url === '/page.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(pageJs);
    // new Worker(new URL('./adjustFrame.worker.ts', import.meta.url)) from /page.js asks for this.
    if (url === '/adjustFrame.worker.ts') {
      return res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(join(assets, workerFile)));
    }
    if (url.startsWith('/assets/')) {
      const name = url.slice('/assets/'.length);
      if (!names.includes(name)) return res.writeHead(404).end();
      const type = name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
      return res.writeHead(200, { 'content-type': type }).end(readFileSync(join(assets, name)));
    }
    if (url === '/log') {
      console.log(`  ${await bodyOf(req)}`);
      return res.end('ok');
    }
    if (url === '/result') {
      const result = JSON.parse(await bodyOf(req));
      res.end('ok');
      const failed = (result.checks ?? []).filter((c) => !c.ok);
      console.log('\ntimings (this machine, headless):');
      for (const [name, value] of Object.entries(result.timings ?? {})) console.log(`  ${name}: ${value}`);
      if (result.error) console.error(`\nthe page stopped: ${result.error}`);
      console.log(`\n${(result.checks ?? []).length - failed.length} of ${(result.checks ?? []).length} checks passed`);
      return finish(failed.length > 0 || result.error || !(result.checks ?? []).length ? 1 : 0);
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const args = ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run'];
    if (flags.has('--software-gl')) args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
    args.push(`http://127.0.0.1:${port}/`);
    console.log('running in headless Chrome…');
    chrome = spawn(chromePath, args, { stdio: 'ignore' });
  });
  setTimeout(() => {
    console.error('check-picture-adjust: no result after five minutes');
    finish(1);
  }, 300000);
}
