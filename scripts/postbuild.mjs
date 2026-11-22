// Copies the app shell to each pre-rendered route so the build works when
// served as plain static files (every route has its own index.html).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoWikis } from '../src/data/demos/index.js';
import { orderPages } from '../src/lib/wiki.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const index = path.join(dist, 'index.html');
// The same shell is served at nested URLs, with or without a trailing slash.
// Anchor its entry URLs to the host root and leave chunk imports relative.
const shell = fs.readFileSync(index, 'utf8').replace(/\b(src|href)="\.\//g, '$1="/');
fs.writeFileSync(index, shell);
const routes = demoWikis.flatMap(wiki => {
  const root = `${wiki.owner}/${wiki.repo}`;
  return [root, `${root}/print`, ...orderPages(wiki.pages).map(page => `${root}/${page.slug}`)];
});
for (const route of routes) {
  const dir = path.join(dist, route);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), shell);
}
fs.writeFileSync(path.join(dist, '404.html'), shell);
console.log(`postbuild: wrote ${routes.length} route pages + 404.html`);
