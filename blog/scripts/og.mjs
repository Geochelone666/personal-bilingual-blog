// Generates 1200x630 share covers into dist/og/<lang>/<slug>.png after `astro build`.
// Free: Google Fonts subset (only the characters used) + satori + resvg. Never fails the build.
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

const ROOT = new URL("..", import.meta.url).pathname;
const POSTS = join(ROOT, "src/content/posts");
const OUT = join(ROOT, "dist/og");
const CAT = {
  zh: { dev: "编程", ai: "AI 科技", finance: "投资", politics: "社会观察", essay: "随笔" },
  en: { dev: "Programming", ai: "AI & Tech", finance: "Markets", politics: "Politics & Society", essay: "Essay" },
};
const fm = (src) => {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  const o = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const k = line.match(/^(\w+):\s*(.*)$/);
    if (k) o[k[1]] = k[2].startsWith('"') ? JSON.parse(k[2]) : k[2];
  }
  return o;
};

async function font(text) {
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@700&text=${encodeURIComponent(text)}`)).text();
  const url = css.match(/src: url\((.+?)\)/)?.[1];
  if (!url) throw new Error("font css without url");
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

function card(title, tag, lang) {
  const size = lang === "zh" ? ([...title].length > 24 ? 60 : 72) : title.length > 60 ? 58 : 70;
  const h = (type, style, children) => ({ type, props: { style, children } });
  return h("div", { width: 1200, height: 630, display: "flex", background: "#f6f1e7", fontFamily: "Noto Sans SC" }, [
    h("div", { width: 18, height: 630, background: "#1f2328" }),
    h("div", { display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "70px 80px", width: 1182 }, [
      h("div", { fontSize: 34, color: "#8a6d3b" }, tag),
      h("div", { fontSize: size, color: "#1f2328", lineHeight: 1.25, display: "flex", flexWrap: "wrap", maxHeight: 330, overflow: "hidden" }, title),
      h("div", { fontSize: 32, color: "#555" }, "砚舟 / INKWARD"),
    ]),
  ]);
}

async function main() {
  const posts = [];
  for (const lang of ["zh", "en"]) {
    const dir = join(POSTS, lang);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      const d = fm(readFileSync(join(dir, f), "utf8"));
      if (d.cover) continue; // custom cover provided
      posts.push({ lang, slug: d.postSlug, title: d.title, tag: CAT[lang][d.category] ?? CAT[lang].essay });
    }
  }
  const chars = new Set([..."砚舟 / INKWARD…", ...Object.values(CAT.zh).join(""), ...Object.values(CAT.en).join(""), ...posts.flatMap((p) => [...p.title])]);
  const data = await font([...chars].join(""));
  posts.push({ lang: "zh", slug: "default", title: "写作、学习与思考", tag: "砚舟" }, { lang: "en", slug: "default", title: "Writing, learning and thinking", tag: "Inkward" });
  const data2 = await font([...chars, ..."写作、学习与思考砚舟Writing, learning and thinkingInkward"].join(""));
  let n = 0;
  for (const p of posts) {
    const svg = await satori(card(p.title, p.tag, p.lang), { width: 1200, height: 630, fonts: [{ name: "Noto Sans SC", data: p.slug === "default" ? data2 : data, weight: 700, style: "normal" }] });
    const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng();
    mkdirSync(join(OUT, p.lang), { recursive: true });
    writeFileSync(join(OUT, p.lang, `${p.slug}.png`), png);
    n++;
  }
  console.log(`og: ${n} covers`);
}
main().catch((e) => console.warn("og: skipped –", e.message));
