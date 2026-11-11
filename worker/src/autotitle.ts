/** Title handling for "just send it" mode. */

const END_PUNCT = /[。！？!?…；;，,：:]$/;

/** If the first line looks like a title the user wrote, use it; otherwise null. */
export function userTitle(text: string): { title: string; body: string } | null {
  const t = text.replace(/\r\n/g, "\n").trim();
  const lines = t.split("\n");
  if (lines.length < 2) return null;
  const first = lines[0].replace(/^#+\s*/, "").replace(/^[《「【](.*)[》」】]$/, "$1").trim();
  const body = lines.slice(1).join("\n").trim();
  if (!first || !body) return null;
  if ([...first].length > 40 || END_PUNCT.test(first)) return null;
  return { title: first, body };
}

/** Fallback title: the first clause of the text, trimmed to ~16 chars. */
export function heuristicTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentence = flat.split(/[。！？!?；;]/)[0] ?? flat;
  const first = sentence.split(/[，,、：:]/)[0] ?? sentence;
  const clause = [...first].length >= 4 ? first : sentence;
  const chars = [...clause.replace(/^[#\s]+/, "")];
  return chars.length > 16 ? chars.slice(0, 16).join("") + "…" : chars.join("") || "随笔";
}

// qwen3-30b is retired by Workers AI on 2026-11-20.
const MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fast"];

function clean(raw: string): string | null {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim().split("\n").map((x) => x.trim()).filter(Boolean)[0] ?? "";
  s = s.replace(/^(标题|题目|Title)\s*[:：]\s*/i, "").replace(/^["'“”《「【\s]+|["'“”》」】\s。.]+$/g, "").trim();
  const n = [...s].length;
  return n >= 2 && n <= 24 ? s : null;
}

/** Ask Workers AI for a short Chinese title; never throws. */
export async function generateTitle(ai: any, text: string): Promise<string> {
  if (ai) {
    const sample = [...text].slice(0, 2000).join("");
    for (const model of MODELS) {
      try {
        const r: any = await ai.run(model, {
          messages: [
            { role: "system", content: "你是博客编辑。为作者的中文随笔起一个简短、贴切的中文标题（4到14个字），保留作者的语气。只输出标题本身，不要引号、书名号或解释。/no_think" },
            { role: "user", content: sample },
          ],
          max_tokens: 400,
        });
        const out = typeof r?.response === "string" ? r.response : r?.choices?.[0]?.message?.content ?? "";
        const t = clean(String(out));
        if (t) return t;
      } catch (e) {
        console.warn("title model failed", model, String(e));
      }
    }
  }
  return heuristicTitle(text);
}
