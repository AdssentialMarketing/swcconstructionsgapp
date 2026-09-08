import path from "node:path";
import { unlink } from "node:fs/promises";
import { pool } from "../db/pool.js";
export async function previewInspectionDeletion(inspectionId) {
    const { rows } = await pool.query(`SELECT i.id AS inspection_id, i.site_address,
            (SELECT count(*)::int FROM inspection_areas a WHERE a.inspection_id = i.id) AS areas,
            (SELECT count(*)::int FROM photos p WHERE p.inspection_id = i.id) AS photos,
            (SELECT count(*)::int FROM quotations q WHERE q.inspection_id = i.id) AS quotations,
            (SELECT count(*)::int FROM quotation_library l
               WHERE l.quotation_id IN (SELECT id FROM quotations WHERE inspection_id = i.id)
                  OR l.photo_id IN (SELECT id FROM photos WHERE inspection_id = i.id)) AS library_entries,
            (SELECT count(*)::int FROM leak_case_examples e
               WHERE e.source_photo_id IN (SELECT id FROM photos WHERE inspection_id = i.id)) AS teaching_cases,
            (SELECT count(*)::int FROM quotations q
               WHERE q.inspection_id = i.id AND q.excel_path IS NOT NULL) AS exported_files
     FROM inspections i WHERE i.id = $1`, [inspectionId]);
    return rows[0] ?? null;
}
export async function deleteInspection(inspectionId) {
    const preview = await previewInspectionDeletion(inspectionId);
    if (!preview)
        return null;
    const client = await pool.connect();
    let filesToRemove = [];
    try {
        await client.query("BEGIN");
        // Collect the paths before the rows go, or there is nothing left to
        // tell us which files belonged to this job.
        const { rows: files } = await client.query(`SELECT p.file_path AS path FROM photos p WHERE p.inspection_id = $1
       UNION ALL
       SELECT q.excel_path FROM quotations q WHERE q.inspection_id = $1 AND q.excel_path IS NOT NULL
       UNION ALL
       SELECT e.image_path FROM leak_case_examples e
        WHERE e.source_photo_id IN (SELECT id FROM photos WHERE inspection_id = $1)`, [inspectionId]);
        filesToRemove = [...new Set(files.map((f) => f.path).filter(Boolean))];
        // Remove what the cascades would otherwise orphan, before the cascade
        // nulls the columns that identify them.
        await client.query(`DELETE FROM leak_case_examples
       WHERE source_photo_id IN (SELECT id FROM photos WHERE inspection_id = $1)`, [inspectionId]);
        await client.query(`DELETE FROM quotation_library
       WHERE quotation_id IN (SELECT id FROM quotations WHERE inspection_id = $1)
          OR photo_id IN (SELECT id FROM photos WHERE inspection_id = $1)`, [inspectionId]);
        await client.query("DELETE FROM inspections WHERE id = $1", [inspectionId]);
        await client.query("COMMIT");
    }
    catch (err) {
        await client.query("ROLLBACK");
        throw err;
    }
    finally {
        client.release();
    }
    // Only once the transaction has committed — a rolled-back delete must not
    // take the files with it. A missing file is ignored: the row is already
    // gone either way.
    for (const relativePath of filesToRemove) {
        await unlink(path.join(process.cwd(), relativePath)).catch(() => { });
    }
    return preview;
}
