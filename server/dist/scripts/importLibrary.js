// Imports historical SWC Construction quotation .xlsx files into
// quotation_library: extracts line items (raw description + price) tagged
// by leak type, detects recurring boilerplate (Payment/Confirmation/
// Validity text), and captures schedule-of-work/warranty as job-specific
// fields. See README.md "Historical import" for usage.
//
// Usage: npm run import:library --workspace server -- <directory>
// (defaults to ../samples at the repo root)
import ExcelJS from "exceljs";
import path from "node:path";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import Anthropic from "@anthropic-ai/sdk";
import { pool } from "../db/pool.js";
import { bumpRefNoFloor, parseRefNo } from "../services/refNumber.js";
import { listLeakTypes } from "../services/leakTypes.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-5";
// Item-level tag for work that isn't tied to a leak type at all (protection
// and PPE, debris disposal, access/scaffolding, cosmetic paint touch-up).
// Every other allowed tag comes from the leak_types table, so the import,
// the vision prompt and retrieval all classify against one vocabulary —
// they used to keep separate hardcoded lists that never agreed, which left
// library rows tagged with types the analyser could never produce.
const GENERAL_TAG = "general";
export async function leakTypeVocabulary() {
    const types = await listLeakTypes();
    return [...types.map((t) => t.name), GENERAL_TAG];
}
function cellText(v) {
    if (v === null || v === undefined)
        return "";
    if (typeof v === "object") {
        const obj = v;
        if (obj.richText)
            return obj.richText.map((t) => t.text).join("");
        if (obj.result !== undefined)
            return String(obj.result);
    }
    if (v instanceof Date)
        return v.toISOString().slice(0, 10);
    return String(v);
}
function cellRaw(sheet, row, col) {
    return sheet.getRow(row).getCell(col).value;
}
/**
 * Reads a cell as a number, unwrapping formula cells.
 *
 * ExcelJS returns a formula cell as { formula, result } rather than its
 * value, and the quotation total is always a =SUM(), so a plain typeof
 * check silently read every total as absent.
 */
function cellNumber(v) {
    if (typeof v === "number")
        return v;
    if (v && typeof v === "object") {
        const result = v.result;
        if (typeof result === "number")
            return result;
    }
    const text = cellText(v).trim();
    if (text === "")
        return null;
    const parsed = Number(text.replace(/[$,\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
}
// Reconstructs a paragraph from wrapped rows: a new line starts a new
// paragraph break if it looks like a lettered sub-point ("a. ", "b. "),
// otherwise it's a word-wrap continuation joined with a space.
function joinDescriptionLines(lines) {
    const paragraphs = [];
    let current = "";
    for (const line of lines) {
        // A blank source row is a deliberate paragraph break in the original
        // (e.g. before a "Please note:" aside) — preserve it instead of letting
        // it silently vanish.
        if (!line.trim()) {
            if (current)
                paragraphs.push(current);
            current = "";
            continue;
        }
        const isSubPoint = /^[a-z]\.\s/i.test(line.trim());
        if (isSubPoint && current) {
            paragraphs.push(current);
            current = line.trim();
        }
        else {
            current = current ? `${current} ${line.trim()}` : line.trim();
        }
    }
    if (current)
        paragraphs.push(current);
    return paragraphs.join("\n");
}
function parseFile(filePath, workbook) {
    const sheet = workbook.worksheets[0];
    if (!sheet)
        throw new Error(`No worksheet found in ${filePath}`);
    return { sheet };
}
export async function extractFile(filePath) {
    const fileName = path.basename(filePath);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const { sheet } = parseFile(filePath, workbook);
    const refNoMatch = fileName.match(/^(SWC\d{5}SS)/);
    const refNo = refNoMatch ? refNoMatch[1] : null;
    const contactName = cellText(cellRaw(sheet, 8, 2)) || null;
    // Locate the "S/N" header row dynamically instead of assuming row 11.
    let headerRow = -1;
    for (let r = 1; r <= sheet.rowCount; r++) {
        if (cellText(cellRaw(sheet, r, 1)).trim().toUpperCase() === "S/N") {
            headerRow = r;
            break;
        }
    }
    if (headerRow === -1)
        throw new Error(`Could not find "S/N" header row in ${fileName}`);
    // Line items: group consecutive rows into items, starting a new item
    // whenever column A (S/N) holds a number. Stop at "Total Amount".
    const items = [];
    let current = null;
    let totalFromSheet = null;
    let r = headerRow + 1;
    for (; r <= sheet.rowCount; r++) {
        const snVal = cellRaw(sheet, r, 1);
        const labelCol8 = cellText(cellRaw(sheet, r, 8)).trim();
        if (labelCol8 === "Total Amount:") {
            // The label sits in the merged H:I of one row and the figure in the
            // merged H:I of the row below it — so the value is column H of the
            // NEXT row, not column I of this one. The other positions are tried
            // as fallbacks because one file (SWCW26083-2) shifts the whole block
            // down a row relative to the others.
            totalFromSheet =
                cellNumber(cellRaw(sheet, r + 1, 8)) ??
                    cellNumber(cellRaw(sheet, r, 9)) ??
                    cellNumber(cellRaw(sheet, r + 1, 9));
            r++;
            break;
        }
        if (typeof snVal === "number") {
            if (current)
                items.push(finalizeItem(current));
            current = { sn: snVal, lines: [], unit: cellText(cellRaw(sheet, r, 8)), amountRaw: cellRaw(sheet, r, 9) };
            const desc = cellText(cellRaw(sheet, r, 2));
            if (desc)
                current.lines.push(desc);
        }
        else if (current) {
            // Push even blank rows — joinDescriptionLines treats them as
            // deliberate paragraph breaks rather than losing them silently.
            current.lines.push(cellText(cellRaw(sheet, r, 2)));
        }
    }
    if (current)
        items.push(finalizeItem(current));
    function finalizeItem(item) {
        let description = joinDescriptionLines(item.lines);
        let unitPrice;
        const amountText = cellText(item.amountRaw).trim();
        if (typeof item.amountRaw === "number") {
            unitPrice = item.amountRaw;
        }
        else if (amountText.toUpperCase() === "INCL") {
            unitPrice = 0;
            description += " (included in above)";
        }
        else {
            unitPrice = 0;
        }
        return { sn: item.sn, description, unit: item.unit || "LS", unitPrice };
    }
    // Terms & conditions: find "TERMS AND CONDITIONS" row, then group rows
    // by label (col A) until "Schedule of work" (handled separately as a
    // job-specific field, not boilerplate).
    let termsHeaderRow = -1;
    for (let i = r; i <= sheet.rowCount; i++) {
        if (cellText(cellRaw(sheet, i, 1)).toUpperCase().includes("TERMS AND CONDITIONS")) {
            termsHeaderRow = i;
            break;
        }
    }
    const termsBlocks = [];
    let scheduleOfWork = null;
    let warrantyText = null;
    if (termsHeaderRow !== -1) {
        let blockLabel = null;
        let blockLines = [];
        const flush = () => {
            if (blockLabel && blockLines.length > 0) {
                termsBlocks.push({ label: blockLabel, text: blockLines.join("\n") });
            }
            blockLabel = null;
            blockLines = [];
        };
        for (let i = termsHeaderRow + 1; i <= sheet.rowCount; i++) {
            const label = cellText(cellRaw(sheet, i, 1)).trim();
            const value = cellText(cellRaw(sheet, i, 3)).replace(/^:\s*/, "").trim();
            if (!label && !value)
                continue;
            if (label.toUpperCase().includes("AUTHORIZATION"))
                break;
            if (label) {
                if (label === "Schedule of work") {
                    flush();
                    scheduleOfWork = value || null;
                    continue;
                }
                if (label === "Warranty") {
                    flush();
                    warrantyText = value || null;
                    continue;
                }
                flush();
                blockLabel = label;
                if (value)
                    blockLines.push(value);
            }
            else if (blockLabel) {
                if (value)
                    blockLines.push(value);
            }
        }
        flush();
    }
    return { fileName, refNo, contactName, items, termsBlocks, scheduleOfWork, warrantyText, totalFromSheet };
}
async function classifyLeakTypes(items, siteAddress) {
    const vocabulary = await leakTypeVocabulary();
    const prompt = `A waterproofing/leakage repair company's historical quotation for site "${siteAddress}" has these line items:

${items.map((it, i) => `${i}. ${it.description}`).join("\n\n")}

Classify each item's leak type using ONLY these categories: ${vocabulary.join(", ")}.
Use "general" for items that aren't leak-specific (e.g. protection/PPE setup, paint touch-up, debris disposal,
scaffolding/access, tiling-only cosmetic work with no waterproofing element).

Respond with ONLY a JSON object (no markdown fences, no prose):
{ "tags": string[], "primary": string }
"tags" must have exactly ${items.length} entries, one per item in order. "primary" is the single most relevant
leak type for the quotation as a whole (prefer a specific leak type over "general" if any item has one).`;
    const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const parsed = JSON.parse(fenced ? fenced[1].trim() : raw.trim());
    return parsed;
}
export async function upsertBoilerplate(block) {
    const existing = await pool.query("SELECT id, usage_count FROM boilerplate_snippets WHERE category = 'terms' AND label = $1 AND text = $2", [block.label, block.text]);
    if (existing.rows.length > 0) {
        await pool.query("UPDATE boilerplate_snippets SET usage_count = usage_count + 1 WHERE id = $1", [
            existing.rows[0].id,
        ]);
    }
    else {
        await pool.query("INSERT INTO boilerplate_snippets (category, label, text, usage_count) VALUES ('terms', $1, $2, 1)", [block.label, block.text]);
    }
}
async function getMapping(dir) {
    const mappingPath = path.join(dir, "client-mapping.json");
    if (existsSync(mappingPath)) {
        return JSON.parse(readFileSync(mappingPath, "utf-8"));
    }
    return {};
}
async function promptFor(rl, question, fallback) {
    const answer = await rl.question(`${question} [${fallback}]: `);
    return answer.trim() || fallback;
}
async function main() {
    const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, "../../../samples");
    const files = readdirSync(dir).filter((f) => f.endsWith(".xlsx"));
    if (files.length === 0) {
        console.log(`No .xlsx files found in ${dir}`);
        return;
    }
    const mapping = await getMapping(dir);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let imported = 0;
    let itemsImported = 0;
    let boilerplateBlocks = 0;
    for (const file of files) {
        const filePath = path.join(dir, file);
        console.log(`\n=== ${file} ===`);
        const parsed = await extractFile(filePath);
        let clientInfo = mapping[file];
        if (!clientInfo) {
            console.log("No mapping entry found — enter details manually:");
            const client_name = await promptFor(rl, "Client name", "");
            const site_address = await promptFor(rl, "Site address", "");
            clientInfo = { client_name, site_address };
        }
        if (parsed.items.length === 0) {
            console.log("  No line items parsed — skipping.");
            continue;
        }
        const sumFromItems = +parsed.items.reduce((sum, it) => sum + it.unitPrice, 0).toFixed(2);
        if (parsed.totalFromSheet !== null && Math.abs(sumFromItems - parsed.totalFromSheet) > 0.01) {
            console.log(`  WARNING: item sum (${sumFromItems}) doesn't match sheet's Total Amount (${parsed.totalFromSheet}). Using sheet total.`);
        }
        const finalPrice = parsed.totalFromSheet ?? sumFromItems;
        const { tags, primary } = await classifyLeakTypes(parsed.items, clientInfo.site_address);
        const lineItems = parsed.items.map((item, i) => ({
            description: item.description,
            quantity: 1,
            unit: item.unit,
            unit_price: item.unitPrice,
            total: item.unitPrice,
            leak_type_tag: tags[i] ?? "general",
        }));
        await pool.query(`INSERT INTO quotation_library
         (leak_type, line_items, final_price, source_type, ref_no, source_file, schedule_of_work, warranty_text)
       VALUES ($1, $2, $3, 'imported', $4, $5, $6, $7)`, [primary, JSON.stringify(lineItems), finalPrice, parsed.refNo, file, parsed.scheduleOfWork, parsed.warrantyText]);
        for (const block of parsed.termsBlocks) {
            await upsertBoilerplate(block);
            boilerplateBlocks++;
        }
        if (parsed.refNo) {
            const ref = parseRefNo(parsed.refNo);
            if (ref)
                await bumpRefNoFloor(ref.year, ref.sequence, ref.initials);
        }
        console.log(`  Imported ${parsed.items.length} items, primary leak_type=${primary}, total=${finalPrice}`);
        console.log(`  Tags: ${tags.join(", ")}`);
        imported++;
        itemsImported += parsed.items.length;
    }
    rl.close();
    console.log(`\nDone. Imported ${imported} quotation(s), ${itemsImported} line item(s), ${boilerplateBlocks} boilerplate block(s) processed.`);
    await pool.end();
}
// Only run when invoked directly. importCaseStudies.ts imports the parser
// and boilerplate helpers from this module, and must not trigger a full
// samples/ import as a side effect of that.
const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    main().catch((err) => {
        console.error("Import failed:", err);
        process.exit(1);
    });
}
