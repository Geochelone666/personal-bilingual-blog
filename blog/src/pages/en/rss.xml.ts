import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import { SITE, SITE_URL, excerpt } from "../../site.config";
export async function GET() {
  const posts = (await getCollection("posts", (p) => p.data.lang === "en")).sort((a, b) => +b.data.date - +a.data.date);
  return rss({
    title: SITE.name.en,
    description: SITE.description.en,
    site: SITE_URL,
    customData: "<language>en</language>",
    items: posts.map((p) => ({
      title: p.data.title,
      link: `/en/posts/${p.data.postSlug}/`,
      pubDate: p.data.date,
      description: excerpt(p.body, 300),
      content: p.rendered?.html,
    })),
  });
}
