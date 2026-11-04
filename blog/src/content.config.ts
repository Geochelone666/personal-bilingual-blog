import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const posts = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/posts" }),
  schema: z.object({
    title: z.string(),
    lang: z.enum(["zh", "en"]),
    postSlug: z.string(),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    articleId: z.string(),
    versionId: z.string(),
    versionHash: z.string(),
    approvalHash: z.string(),
    translationOf: z.string().optional(),
  }),
});

export const collections = { posts };
