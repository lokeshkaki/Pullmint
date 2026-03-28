import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://lokeshkaki.github.io',
  base: '/pullmint',
  integrations: [tailwind(), sitemap()],
  build: {
    assets: '_assets',
  },
});