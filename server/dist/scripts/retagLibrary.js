import Anthropic from "@anthropic-ai/sdk";
import { pool } from "../db/pool.js";
import { listLeakTypes } from "../services/leakTypes.js";
// Re-classifies every quotation_library row against the current leak_types
// vocabulary.
//
// Retrieval matches a photo's leak_type against these tags exactly, so a
// library tagged with an older or narrower vocabulary silently starves the
// drafter of pricing references — a photo correctly classified as "roof
// leak" finds nothing if the only tags in the library are crack, seepage and
// pipe leak. Run this after adding or renaming leak types.
//
// Usage: npm run retag:library --workspace server
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-5";
const GENERAL_TAG = "general";
async function classify(items, vocabulary, refNo) {
    const prompt = `A Singapore waterproofing and leakage repair company's quotation${refNo ? ` (${refNo})` : ""} has these line items:

${items.map((item, i) => `${i}. ${item.description}`).join("\n\n")}

Classify each item's leak type using ONLY these categories: ${vocabulary.join(", ")}.
Use "${GENERAL_TAG}" for items that aren't leak-specific (protection/PPE setup, debris disposal,
scaffolding or access provision, cosmetic paint touch-up with no waterproofing element).
Judge by the repair being performed: polyurethane injection grouting into cracks and joints is
"crack"; resealing awning bolts or roof penetrations is "roof leak"; resealing a perished joint or
threshold is "joint failure"; replacing a leaking pipe is "pipe leak".

Respond with ONLY a JSON object (no markdown fences, no prose):
{ "tags": string[], "primary": string }
"tags" must have exactly ${items.length} entries, one per item in order. "primary" is the single most
relevant leak type for the quotation as a whole — prefer a specific leak type over "${GENERAL_TAG}".`;
    const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
    });
    const block = response.content.find((b) => b.type === "text");
    const raw = block && block.type === "text" ? block.text : "";
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    return JSON.parse(fenced ? fenced[1].trim() : raw.trim());
}
async function retag() {
    const types = await listLeakTypes();
    if (types.length === 0) {
        throw new Error("No leak types configured — run `npm run seed:leaktypes --workspace server` first.");
    }
    const names = types.map((t) => t.name);
    const allowed = new Set([...names, GENERAL_TAG]);
    console.log(`Vocabulary: ${[...allowed].join(", ")}\n`);
    const { rows } = await pool.query("SELECT id, ref_no, leak_type, line_items FROM quotation_library ORDER BY id");
    for (const row of rows) {
        const items = row.line_items;
        const { tags, primary } = await classify(items, names, row.ref_no);
        const cleanTags = items.map((_, i) => {
            const tag = (tags[i] ?? "").trim().toLowerCase();
            return allowed.has(tag) ? tag : GENERAL_TAG;
        });
        const cleanPrimary = allowed.has((primary ?? "").trim().toLowerCase())
            ? primary.trim().toLowerCase()
            : cleanTags.find((t) => t !== GENERAL_TAG) ?? GENERAL_TAG;
        const retagged = items.map((item, i) => ({ ...item, leak_type_tag: cleanTags[i] }));
        await pool.query("UPDATE quotation_library SET leak_type = $1, line_items = $2 WHERE id = $3", [
            cleanPrimary,
            JSON.stringify(retagged),
            row.id,
        ]);
        const changed = row.leak_type !== cleanPrimary ? `  (was "${row.leak_type}")` : "";
        console.log(`#${row.id} ${row.ref_no ?? ""} -> ${cleanPrimary}${changed}`);
        for (const [i, tag] of cleanTags.entries()) {
            console.log(`     ${tag.padEnd(20)} ${items[i].description.slice(0, 62)}`);
        }
    }
    const { rows: summary } = await pool.query(`SELECT item->>'leak_type_tag' AS tag, count(*) AS n
     FROM quotation_library, jsonb_array_elements(line_items) item
     GROUP BY 1 ORDER BY 2 DESC`);
    console.log("\nItem tags now in the library:");
    for (const row of summary)
        console.log(`  ${String(row.n).padStart(3)}  ${row.tag}`);
    await pool.end();
}
retag().catch((err) => {
    console.error("Re-tagging failed:", err);
    process.exit(1);
});
