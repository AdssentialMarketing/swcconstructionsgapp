import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { pool } from "../db/pool.js";
import { extractFile, leakTypeVocabulary, upsertBoilerplate } from "./importLibrary.js";
import { listLeakTypes, resolveLeakType } from "../services/leakTypes.js";
import { analyzeInspectionPhotos } from "../services/claudeVision.js";
import { bumpRefNoFloor, parseRefNo } from "../services/refNumber.js";
// Imports a folder of past jobs, each one a photo set plus the Excel
// quotation that was actually sent for it.
//
// The two halves feed different parts of the app and are both needed: the
// quotation gives retrieval real prices and the company's own wording for a
// leak type, the photos give the vision model worked examples of what that
// leak type looks like. A correctly classified photo with no matching
// quotation still drafts every line at $0.
//
// Usage:
//   npm run import:cases --workspace server            # dry run, changes nothing
//   npm run import:cases --workspace server -- --commit # write, then move folders to trained/
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-5";
const CASE_DIR = path.resolve(__dirname, "../../../case-studies");
const TRAINED_DIR = path.join(CASE_DIR, "trained");
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
// Photos of one job are near-duplicates, and only a handful of example
// images fit in each analysis prompt anyway. The most diagnostic few are
// sent as images; the rest are kept as labels only, and can be switched on
// individually from the Training page.
const IMAGES_PER_CASE = 2;
/** Parses notes.txt: `key: value` lines, with indented continuation lines. */
function parseNotes(filePath) {
    const notes = { reported: null, leakType: null, note: null };
    if (!existsSync(filePath))
        return notes;
    const fields = new Map();
    let current = null;
    for (const rawLine of readFileSync(filePath, "utf8").split("\n")) {
        const keyed = rawLine.match(/^([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/);
        if (keyed && !/^\s/.test(rawLine)) {
            current = keyed[1].trim().toLowerCase();
            fields.set(current, keyed[2].trim());
        }
        else if (current && rawLine.trim() !== "") {
            fields.set(current, `${fields.get(current)} ${rawLine.trim()}`.trim());
        }
    }
    notes.reported = fields.get("reported") || null;
    notes.leakType = fields.get("leak type") || fields.get("leak_type") || null;
    notes.note = fields.get("note") || fields.get("notes") || null;
    return notes;
}
function scanCases() {
    if (!existsSync(CASE_DIR))
        return [];
    return readdirSync(CASE_DIR)
        .filter((name) => {
        if (name.startsWith("_") || name.startsWith(".") || name === "trained")
            return false;
        return statSync(path.join(CASE_DIR, name)).isDirectory();
    })
        .sort()
        .map((name) => {
        const dir = path.join(CASE_DIR, name);
        const entries = readdirSync(dir).filter((f) => !f.startsWith("."));
        return {
            name,
            dir,
            quotationFile: entries.find((f) => f.toLowerCase().endsWith(".xlsx")) ?? null,
            photos: entries.filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase())).sort(),
            notes: parseNotes(path.join(dir, "notes.txt")),
        };
    });
}
/**
 * Works out the leak type from the quotation's line items.
 *
 * The line items say what was actually repaired, which is firmer evidence
 * than either the photos or a free-text note — polyurethane injection
 * grouting means a crack job whatever the photo happens to show.
 */
async function classifyFromQuotation(descriptions, siteAddress, vocabulary) {
    const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 512,
        messages: [
            {
                role: "user",
                content: `A Singapore waterproofing company's quotation for "${siteAddress}" contains these line items:

${descriptions.map((d, i) => `${i + 1}. ${d}`).join("\n")}

Which single leak type is this job about? Answer with EXACTLY one of: ${vocabulary.join(", ")}.
Judge by the repair performed: polyurethane injection grouting into cracks or joints is "crack";
resealing roof tiles, awning bolts or roof penetrations is "roof leak"; replacing a leaking pipe is
"pipe leak"; recoating a facade reached by boomlift or rope access is "external wall leak"; resealing
a perished sealant joint or threshold is "joint failure".

Reply with the leak type string and nothing else.`,
            },
        ],
    });
    const block = response.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text.trim() : "";
}
// A single call carrying every photo of a large case returned a truncated,
// unparseable response (13 images at once), so they go in batches. Each
// batch still sees several photos together, which is the point — it is only
// the whole-case call that was too big.
const VISION_BATCH = 5;
async function analyzePhotosInBatches(filePaths, context) {
    const photos = [];
    const summaries = [];
    const typeVotes = new Map();
    for (let i = 0; i < filePaths.length; i += VISION_BATCH) {
        const batch = filePaths.slice(i, i + VISION_BATCH);
        const result = await analyzeInspectionPhotos(batch.map((filePath) => ({ filePath })), context);
        photos.push(...result.photos);
        if (result.summary)
            summaries.push(result.summary);
        typeVotes.set(result.primaryLeakType, (typeVotes.get(result.primaryLeakType) ?? 0) + batch.length);
    }
    const primaryLeakType = [...typeVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";
    return {
        photos,
        primaryLeakType,
        overallSeverity: photos[0]?.severity ?? "minor",
        summary: summaries[0] ?? "",
    };
}
async function run() {
    const commit = process.argv.includes("--commit");
    const cases = scanCases();
    if (cases.length === 0) {
        console.log(`No case folders found in ${CASE_DIR}`);
        await pool.end();
        return;
    }
    const types = await listLeakTypes();
    const vocabulary = await leakTypeVocabulary();
    const typeNames = types.map((t) => t.name);
    console.log(commit ? "COMMITTING\n" : "DRY RUN — nothing will be written. Add --commit to apply.\n");
    const done = [];
    for (const study of cases) {
        console.log("=".repeat(94));
        console.log(`${study.name}   (${study.photos.length} photo(s), ${study.quotationFile ?? "no quotation"})`);
        if (study.notes.reported)
            console.log(`  reported : ${study.notes.reported}`);
        if (study.notes.leakType)
            console.log(`  you said : ${study.notes.leakType}`);
        if (!study.quotationFile && study.photos.length === 0) {
            console.log("  nothing to import — skipped");
            continue;
        }
        // --- the quotation -----------------------------------------------
        let parsed = null;
        let alreadyInLibrary = false;
        if (study.quotationFile) {
            parsed = await extractFile(path.join(study.dir, study.quotationFile));
            // Matched on the source filename as well as the ref number: one file
            // (SWCW26083-2) uses a different ref scheme that doesn't parse, and
            // without the filename check a re-run would import it twice.
            const { rows } = await pool.query("SELECT id FROM quotation_library WHERE ($1::text IS NOT NULL AND ref_no = $1) OR source_file = $2", [parsed.refNo, study.quotationFile]);
            alreadyInLibrary = rows.length > 0;
        }
        // --- leak type ----------------------------------------------------
        // The note's wording is tried first, then the quotation's line items.
        // A note like "wall and floor / crack / toilet waterproofing" describes
        // the job rather than naming a vocabulary entry, so it often will not
        // resolve and the quotation decides.
        let leakType = "";
        let source = "";
        if (study.notes.leakType) {
            const resolved = resolveLeakType(study.notes.leakType, types);
            if (resolved.matched) {
                leakType = resolved.leakType;
                source = "your note";
            }
        }
        if (!leakType && parsed && parsed.items.length > 0) {
            const answer = await classifyFromQuotation(parsed.items.map((i) => i.description), study.name, typeNames);
            const resolved = resolveLeakType(answer, types);
            leakType = resolved.leakType;
            source = `quotation line items (model said "${answer}")`;
        }
        if (!leakType) {
            leakType = "other";
            source = "fallback";
        }
        console.log(`  leak type: ${leakType}   [from ${source}]`);
        // --- the photos ---------------------------------------------------
        let vision = null;
        if (study.photos.length > 0) {
            try {
                vision = await analyzePhotosInBatches(study.photos.map((file) => path.join(study.dir, file)), {
                    siteAddress: study.name,
                    reportedIssue: study.notes.reported,
                });
                const agrees = vision.primaryLeakType === leakType;
                console.log(`  photos   : model reads them as "${vision.primaryLeakType}" ${agrees ? "(agrees)" : `(DISAGREES with "${leakType}" — the quotation wins)`}`);
                if (vision.summary)
                    console.log(`  summary  : ${vision.summary}`);
            }
            catch (err) {
                console.log(`  photos   : analysis failed (${err.message}) — labels only`);
            }
        }
        if (!commit) {
            if (parsed) {
                console.log(alreadyInLibrary
                    ? `  -> quotation ${parsed.refNo} already in the library, would skip (photos still imported)`
                    : `  -> would add quotation ${parsed.refNo ?? "(no ref)"}: ${parsed.items.length} items, total ${parsed.totalFromSheet ?? parsed.items.reduce((sum, i) => sum + i.unitPrice, 0)}`);
            }
            console.log(`  -> would add ${study.photos.length} teaching example(s), ${Math.min(IMAGES_PER_CASE, study.photos.length)} sent as images`);
            continue;
        }
        // --- write --------------------------------------------------------
        if (parsed && parsed.items.length > 0 && !alreadyInLibrary) {
            const sumFromItems = +parsed.items.reduce((sum, it) => sum + it.unitPrice, 0).toFixed(2);
            const finalPrice = parsed.totalFromSheet ?? sumFromItems;
            const itemTags = await classifyItemTags(parsed.items.map((i) => i.description), leakType, vocabulary);
            const lineItems = parsed.items.map((item, i) => ({
                description: item.description,
                quantity: 1,
                unit: item.unit,
                unit_price: item.unitPrice,
                total: item.unitPrice,
                leak_type_tag: itemTags[i],
            }));
            await pool.query(`INSERT INTO quotation_library
           (leak_type, line_items, final_price, source_type, ref_no, source_file, schedule_of_work, warranty_text)
         VALUES ($1, $2, $3, 'imported', $4, $5, $6, $7)`, [
                leakType,
                JSON.stringify(lineItems),
                finalPrice,
                parsed.refNo,
                study.quotationFile,
                parsed.scheduleOfWork,
                parsed.warrantyText,
            ]);
            for (const block of parsed.termsBlocks)
                await upsertBoilerplate(block);
            if (parsed.refNo) {
                const ref = parseRefNo(parsed.refNo);
                if (ref)
                    await bumpRefNoFloor(ref.year, ref.sequence, ref.initials);
            }
            console.log(`  + quotation ${parsed.refNo}: ${parsed.items.length} items, total ${finalPrice}`);
        }
        else if (alreadyInLibrary) {
            console.log(`  = quotation ${parsed?.refNo} already in the library, skipped`);
        }
        // Rank by the model's own per-photo confidence so the clearest shots are
        // the ones actually sent in future prompts.
        const ranked = study.photos
            .map((file, i) => ({ file, confidence: vision?.photos[i]?.confidence ?? 0, analysis: vision?.photos[i] }))
            .sort((a, b) => b.confidence - a.confidence);
        mkdirSync(UPLOAD_DIR, { recursive: true });
        for (const [rank, photo] of ranked.entries()) {
            const stored = `${randomUUID()}${path.extname(photo.file).toLowerCase()}`;
            copyFileSync(path.join(study.dir, photo.file), path.join(UPLOAD_DIR, stored));
            const teachingNote = [
                study.notes.reported ? `Reported by the customer: ${study.notes.reported}` : null,
                study.notes.note,
                `From ${study.name}${parsed?.refNo ? ` (${parsed.refNo})` : ""}.`,
            ]
                .filter(Boolean)
                .join(" ");
            await pool.query(`INSERT INTO leak_case_examples
           (image_path, leak_type, severity, cause, location_notes, repair_approach, notes, use_image)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
                path.join("uploads", stored),
                leakType,
                photo.analysis?.severity ?? null,
                photo.analysis?.cause ?? null,
                photo.analysis?.location_notes ?? null,
                // What was actually billed is better ground truth for the repair
                // than what the model guessed from the photo.
                parsed?.items.find((i) => !/protection and safety|make good damaged paintworks/i.test(i.description))
                    ?.description ?? photo.analysis?.suggested_repair_approach ?? null,
                teachingNote,
                rank < IMAGES_PER_CASE,
            ]);
        }
        console.log(`  + ${study.photos.length} teaching example(s), ${Math.min(IMAGES_PER_CASE, study.photos.length)} sent as images`);
        done.push(study);
    }
    if (commit && done.length > 0) {
        mkdirSync(TRAINED_DIR, { recursive: true });
        for (const study of done) {
            const target = path.join(TRAINED_DIR, study.name);
            if (existsSync(target)) {
                console.log(`\n! ${study.name} already exists in trained/ — left in place`);
                continue;
            }
            renameSync(study.dir, target);
        }
        console.log(`\nMoved ${done.length} folder(s) into case-studies/trained/`);
    }
    const { rows } = await pool.query(`SELECT lt.name,
            (SELECT count(*) FROM quotation_library q WHERE q.leak_type = lt.name) AS quotations,
            (SELECT count(*) FROM leak_case_examples e WHERE e.leak_type = lt.name AND e.is_active) AS photos
     FROM leak_types lt WHERE lt.is_active ORDER BY 2 DESC, 1`);
    console.log("\nCoverage now:");
    console.log(`  ${"leak type".padEnd(22)} quotations  photos`);
    for (const row of rows) {
        console.log(`  ${row.name.padEnd(22)} ${String(row.quotations).padStart(10)}  ${String(row.photos).padStart(6)}`);
    }
    await pool.end();
}
/** Tags each line item, so generic rows (protection, making good) don't pollute phrasing retrieval. */
async function classifyItemTags(descriptions, primary, vocabulary) {
    const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        messages: [
            {
                role: "user",
                content: `Classify each line item of a waterproofing quotation (overall type: "${primary}").
Use ONLY these tags: ${vocabulary.join(", ")}.
Use "general" for items that aren't leak-specific: protection/PPE setup, debris disposal, access or
scaffolding provision, and cosmetic making good of paintwork.

${descriptions.map((d, i) => `${i}. ${d}`).join("\n\n")}

Reply with ONLY a JSON array of exactly ${descriptions.length} strings, in order.`,
            },
        ],
    });
    const block = response.content.find((b) => b.type === "text");
    const raw = block && block.type === "text" ? block.text : "[]";
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    try {
        const tags = JSON.parse(fenced ? fenced[1].trim() : raw.trim());
        const allowed = new Set(vocabulary);
        return descriptions.map((_, i) => {
            const tag = (tags[i] ?? "").trim().toLowerCase();
            return allowed.has(tag) ? tag : "general";
        });
    }
    catch {
        return descriptions.map(() => "general");
    }
}
run().catch((err) => {
    console.error("Case study import failed:", err);
    process.exit(1);
});
