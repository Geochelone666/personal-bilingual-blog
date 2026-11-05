// Public identity (user, 2026-11-05). No real name anywhere on the site.
export const SITE = {
  name: { zh: "砚舟", en: "Inkward" },
  mark: "砚舟 / INKWARD",
  description: { zh: "写作、学习与思考", en: "Writing, learning and thinking" },
  author: { zh: "砚舟", en: "Inkward" },
};
// Production builds are indexable only on the production branch.
export const IS_PRODUCTION = (process.env.CF_PAGES_BRANCH ?? "main") === "main";
