import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pool } from "../db/pool.js";
import { normaliseStoredImage } from "../services/imageStorage.js";
/**
 * Shrinks photos stored before uploads were normalised.
 *
 * They were kept at full phone resolution while only a 1568px version was
 * ever shown to the model, so this rewrites each one to what is actually
 * used and repoints every row that names it.
 *
 * Run with --apply to write; without it, reports what would change.
 */
const apply = process.argv.includes("--apply");
const dir = path.join(process.cwd(), "uploads");
const files = readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
let before = 0;
let after = 0;
let renamed = 0;
let skipped = 0;
for (const name of files) {
    const absolute = path.join(dir, name);
    const size = statSync(absolute).size;
    before += size;
    if (!apply) {
        // Measure without touching the file: encode to a buffer and discard.
        const sharp = (await import("sharp")).default;
        try {
            const buf = await sharp(absolute)
                .rotate()
                .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
                .jpeg({ quality: 82 })
                .toBuffer();
            after += buf.length;
            if (!name.toLowerCase().endsWith(".jpg"))
                renamed += 1;
        }
        catch {
            after += size;
            skipped += 1;
        }
        continue;
    }
    const result = await normaliseStoredImage(absolute);
    if (!result.normalised) {
        after += size;
        skipped += 1;
        continue;
    }
    after += result.sizeBytes;
    const oldPath = path.join("uploads", name);
    const newPath = path.relative(process.cwd(), result.filePath);
    if (oldPath !== newPath) {
        renamed += 1;
        // Both tables name files by path, so both have to follow the rename.
        await pool.query("UPDATE photos SET file_path = $1 WHERE file_path = $2", [newPath, oldPath]);
        await pool.query("UPDATE leak_case_examples SET image_path = $1 WHERE image_path = $2", [newPath, oldPath]);
    }
    await pool.query("UPDATE photos SET size_bytes = $1, mime_type = 'image/jpeg' WHERE file_path = $2", [
        result.sizeBytes,
        newPath,
    ]);
}
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
console.log(apply ? "APPLIED" : "DRY RUN — nothing written");
console.log(`  files          : ${files.length}`);
console.log(`  before         : ${mb(before)}`);
console.log(`  after          : ${mb(after)}`);
console.log(`  saved          : ${mb(before - after)} (${(((before - after) / before) * 100).toFixed(0)}%)`);
console.log(`  re-extensioned : ${renamed}`);
console.log(`  unreadable     : ${skipped} (left as they are)`);
await pool.end();
