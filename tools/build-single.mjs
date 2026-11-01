// Bundles the app into one self-contained HTML file (no server needed for the
// worklet: it is embedded and loaded from a blob: URL).
// Usage: node tools/build-single.mjs [out.html] [--artifact]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const out = process.argv[2] || path.join(root, 'dist/chroma-console.html');
const artifact = process.argv.includes('--artifact');

const order = ['meta', 'knob', 'gesture', 'presets', 'engine', 'main'];
let js = 'const __m = {};\n';
for (const name of order) {
  let src = read(`js/${name}.js`);
  const exported = [];
  src = src.replace(/^import\s*\{([^}]+)\}\s*from\s*'\.\/(\w+)\.js';\s*$/gm, (_, names, mod) => `const {${names}} = __m.${mod};`);
  src = src.replace(/^export\s+(const|let|function|class|async function)\s+(\w+)/gm, (_, kw, id) => { exported.push(id); return `${kw} ${id}`; });
  if (/^\s*(import|export)\s/m.test(src)) throw new Error(`unhandled import/export in ${name}.js`);
  js += `__m.${name} = (() => {\n${src}\nreturn { ${exported.join(', ')} };\n})();\n`;
}

const worklet = read('worklet/chroma-processor.js');
const css = read('css/style.css');
const html = read('index.html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script type="module"'));
const fonts = '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">';
const boot = `window.__CHROMA_WORKLET_URL = URL.createObjectURL(new Blob([${JSON.stringify(worklet).replace(/<\//g, '<\\/')}], { type: 'application/javascript' }));\n${artifact ? 'window.__CHROMA_ARTIFACT = true;\n' : ''}`;
const page = artifact
  ? `<title>Chroma Console Web</title>\n${fonts}\n<style>\n${css}\n</style>\n${body}\n<script type="module">\n${boot}${js}\n</script>\n`
  : `<!doctype html>\n<html lang="de">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Chroma Console Web</title>\n${fonts}\n<style>\n${css}\n</style>\n</head>\n<body>\n${body}\n<script type="module">\n${boot}${js}\n</script>\n</body>\n</html>\n`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log(`wrote ${out} (${(page.length / 1024).toFixed(0)} kB)`);
