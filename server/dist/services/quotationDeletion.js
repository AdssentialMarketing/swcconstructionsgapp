import { unlink } from "node:fs/promises";
import { pool } from "../db/pool.js";
export async function previewQuotationDeletion(quotationId) {
    const { rows } = await pool.query(`SELECT q.id AS quotation_id, q.ref_no, q.status, q.total, i.site_address,
            (SELECT count(*)::int FROM quotations s
              WHERE s.inspection_id = q.inspection_id AND s.id <> q.id) AS siblings,
            (SELECT count(*)::int FROM quotation_library l WHERE l.quotation_id = q.id) AS library_entries,
            q.excel_path IS NOT NULL AS has_export,
            (SELECT count(*) FROM quotations s WHERE s.inspection_id = q.inspection_id) = 1 AS is_only_quotation
       FROM quotations q
       JOIN inspections i ON i.id = q.inspection_id
      WHERE q.id = $1`, [quotationId]);
    return rows[0] ?? null;
}
export async function deleteQuotation(quotationId) {
    const preview = await previewQuotationDeletion(quotationId);
    if (!preview)
        return null;
    const client = await pool.connect();
    let exportToRemove = null;
    try {
        await client.query("BEGIN");
        const { rows: row } = await client.query("SELECT excel_path, inspection_id FROM quotations WHERE id = $1", [quotationId]);
        exportToRemove = row[0]?.excel_path ?? null;
        const inspectionId = row[0].inspection_id;
        // Before the row goes, or the link back to it is lost.
        await client.query("DELETE FROM quotation_library WHERE quotation_id = $1", [quotationId]);
        await client.query("DELETE FROM quotation_reviews WHERE quotation_id = $1", [quotationId]);
        await client.query("DELETE FROM quotations WHERE id = $1", [quotationId]);
        // A job with no quotations left is back to being un-quoted. Left at
        // "quoted" it would sit in the list claiming work that no longer exists.
        await client.query(`UPDATE inspections SET status = 'draft'
        WHERE id = $1
          AND status <> 'draft'
          AND NOT EXISTS (SELECT 1 FROM quotations q WHERE q.inspection_id = $1)`, [inspectionId]);
        await client.query("COMMIT");
    }
    catch (err) {
        await client.query("ROLLBACK");
        throw err;
    }
    finally {
        client.release();
    }
    // Only after the transaction commits — a rolled-back delete must not have
    // taken the customer's exported quotation with it.
    if (exportToRemove)
        await unlink(exportToRemove).catch(() => { });
    return preview;
}
