import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// SITE is the public pages.dev URL; overridable at build time.
export default defineConfig({
  site: process.env.SITE_URL || "https://personal-bilingual-blog.pages.dev",
  trailingSlash: "always",
  // Hovered links load before the tap, so moving between posts feels instant.
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  build: { inlineStylesheets: "always" },
  integrations: [sitemap({ filter: (p) => !/\/(search|404)\//.test(p) })],
});
