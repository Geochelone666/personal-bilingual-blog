// Placeholder public name — change freely, nothing else depends on it.
export const SITE = {
  name: { zh: "未命名博客", en: "Untitled Blog" },
  description: { zh: "写作、学习与思考", en: "Writing, learning and thinking" },
  author: "Yi Zhou",
};
// Production builds are indexable only on the production branch.
export const IS_PRODUCTION = (process.env.CF_PAGES_BRANCH ?? "main") === "main";
