import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import { SITE, SITE_URL, excerpt } from "../../site.config";
export async function GET() {
  const posts = (await getCollection("posts", (p) => p.data.lang === "zh")).sort((a, b) => +b.data.date - +a.data.date);
  return rss({
    title: SITE.name.zh,
    description: SITE.description.zh,
    site: SITE_URL,
    customData: "<language>zh-cn</language>",
    items: posts.map((p) => ({
      title: p.data.title,
      link: `/zh/posts/${p.data.postSlug}/`,
      pubDate: p.data.date,
      description: excerpt(p.body, 300),
      content: p.rendered?.html,
    })),
  });
}
