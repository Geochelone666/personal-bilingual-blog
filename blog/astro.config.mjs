import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// SITE is the public pages.dev URL; overridable at build time.
export default defineConfig({
  site: process.env.SITE_URL || "https://personal-bilingual-blog.pages.dev",
  trailingSlash: "always",
  integrations: [sitemap()],
});
