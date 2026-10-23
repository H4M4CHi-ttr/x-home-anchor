import { build } from 'esbuild';
import { mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/content.ts', 'src/popup.ts'], outdir: 'dist', bundle: true, format: 'iife', target: 'chrome120', legalComments: 'none' });
for (const file of ['LICENSE', 'manifest.json', 'popup.html', 'popup.css']) {
  await copyFile(['LICENSE', 'manifest.json'].includes(file) ? file : `src/${file}`, `dist/${file}`);
}

const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const contentScript = manifest.content_scripts[0];
const metadata = [
  '// ==UserScript==',
  `// @name         ${manifest.name}`,
  '// @namespace    https://github.com/H4M4CHi-ttr/x-home-anchor',
  `// @version      ${manifest.version}`,
  `// @description  ${manifest.description}`,
  '// @author       akiweb8528',
  '// @homepageURL  https://github.com/H4M4CHi-ttr/x-home-anchor',
  '// @license      MIT',
  ...contentScript.matches.map(match => `// @match        ${match}`),
  `// @run-at       ${contentScript.run_at.replace('_', '-')}`,
  '// @noframes',
  '// @grant        none',
  '// ==/UserScript==',
].join('\n');
const license = (await readFile('dist/LICENSE', 'utf8')).trim();
const content = await readFile('dist/content.js', 'utf8');
await mkdir('dist-userscript', { recursive: true });
await writeFile('dist-userscript/x-home-anchor.user.js', `${metadata}\n\n/*\n${license}\n*/\n\n${content}`);
