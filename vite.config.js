import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import campus from './campus/vite-plugin.js';

const root = dirname(fileURLToPath(import.meta.url));
const pages = ['index', 'cet4', 'cet6', 'school', 'knowledge', 'projects', 'community', 'profile', 'contribute', 'discover', 'auth', 'me', 'map', 'project', 'reputation', 'design'];

// 极简 HTML 片段引入：<!-- @include nav --> → src/partials/nav.html
function partials() {
  const dir = resolve(root, 'src/partials');
  return {
    name: 'luokixi-partials',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) =>
        html.replace(/<!--\s*@include\s+([\w-]+)\s*-->/g, (_, name) =>
          readFileSync(resolve(dir, `${name}.html`), 'utf8'),
        ),
    },
    handleHotUpdate({ file, server }) {
      if (file.startsWith(dir)) server.ws.send({ type: 'full-reload' });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [partials(), campus()],
  build: {
    rollupOptions: {
      input: Object.fromEntries(pages.map((p) => [p, resolve(root, `${p}.html`)])),
    },
  },
});
