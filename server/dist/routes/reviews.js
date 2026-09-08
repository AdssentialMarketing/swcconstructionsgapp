import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { listLeakTypes, resolveLeakType } from "../services/leakTypes.js";
import { normaliseScheduleOfWork, normaliseWarrantyText } from "../services/quotationTerms.js";
import { promoteToLibrary } from "../services/libraryPromotion.js";
import { addPhotosToTeachingSet } from "../services/teachingSetPromotion.js";
export const reviewsRouter = Router();
/**
 * Administrator review of everyone's quotations before they train the model.
 *
 * The amendments made here are training-only: they are stored on
 * quotation_reviews and applied when writing to the reference library. The
 * quotations row — the document the customer was actually sent — is never
 * written to by anything in this file.
 */
/** The values that will be written to the library: the review's where set, else the quotation's. */
function effective(row) {
    return {
        lineItems: row.review_line_items ?? row.line_items,
        leakType: row.review_leak_type,
        scheduleOfWork: row.review_schedule_of_work ?? row.schedule_of_work,
        warrantyText: row.review_warranty_text ?? row.warranty_text,
        finalPrice: Number(row.review_final_price ?? row.total),
    };
}
reviewsRouter.get("/reviews", requireAdmin, asyncHandler(async (req, res) => {
    const status = String(req.query.status ?? "all");
    const { rows } = await pool.query(`SELECT q.id, q.ref_no, q.total, q.status AS quotation_status, q.created_at,
              i.site_address, i.company_name,
              u.name AS prepared_by_name, u.role AS prepared_by_role,
              r.id AS review_id, r.status AS review_status, r.notes AS review_notes,
              r.reviewed_at, r.line_items IS NOT NULL AS amended,
              (SELECT COUNT(*)::int FROM quotation_library l WHERE l.quotation_id = q.id) AS library_rows
       FROM quotations q
       JOIN inspections i ON i.id = q.inspection_id
       LEFT JOIN users u ON u.id = COALESCE(q.prepared_by, i.created_by)
       LEFT JOIN quotation_reviews r ON r.quotation_id = q.id
       -- Only quotations prepared by a salesperson: an administrator's own
       -- approval already went straight into the library, so listing it here
       -- would invite approving the same thing twice.
       WHERE COALESCE(u.role, 'user') = 'user'
         AND ($1 = 'all' OR COALESCE(r.status, 'pending') = $1)
       ORDER BY COALESCE(r.status, 'pending') = 'pending' DESC, q.created_at DESC`, [status]);
    res.json(rows);
}));
reviewsRouter.get("/reviews/:quotationId", requireAdmin, asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`SELECT q.id, q.ref_no, q.line_items, q.total, q.currency, q.status AS quotation_status,
              q.schedule_of_work, q.warranty_text,
              i.id AS inspection_id, i.site_address, i.company_name, i.reported_issue,
              u.name AS prepared_by_name,
              r.id AS review_id, r.status AS review_status, r.notes AS review_notes,
              r.line_items AS review_line_items, r.leak_type AS review_leak_type,
              r.schedule_of_work AS review_schedule_of_work, r.warranty_text AS review_warranty_text,
              r.final_price AS review_final_price, r.reviewed_at
       FROM quotations q
       JOIN inspections i ON i.id = q.inspection_id
       LEFT JOIN users u ON u.id = COALESCE(q.prepared_by, i.created_by)
       LEFT JOIN quotation_reviews r ON r.quotation_id = q.id
       WHERE q.id = $1`, [req.params.quotationId]);
    if (rows.length === 0)
        return res.status(404).json({ error: "Quotation not found" });
    const { rows: photos } = await pool.query(`SELECT id, file_path, COALESCE(corrected_analysis, ai_analysis) AS analysis
       FROM photos WHERE inspection_id = $1 ORDER BY id`, [rows[0].inspection_id]);
    res.json({ ...rows[0], photos, effective: effective(rows[0]) });
}));
/** Save training-only amendments. Never touches the quotation itself. */
reviewsRouter.put("/reviews/:quotationId", requireAdmin, asyncHandler(async (req, res) => {
    const { line_items, leak_type, schedule_of_work, warranty_text, final_price, notes } = req.body ?? {};
    let leakType = null;
    if (leak_type) {
        const resolved = resolveLeakType(leak_type, await listLeakTypes(false));
        if (!resolved.matched)
            return res.status(400).json({ error: `"${leak_type}" is not a known leak type.` });
        leakType = resolved.leakType;
    }
    const { rows } = await pool.query(`INSERT INTO quotation_reviews
         (quotation_id, line_items, leak_type, schedule_of_work, warranty_text, final_price, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (quotation_id) DO UPDATE SET
         line_items = EXCLUDED.line_items,
         leak_type = EXCLUDED.leak_type,
         schedule_of_work = EXCLUDED.schedule_of_work,
         warranty_text = EXCLUDED.warranty_text,
         final_price = EXCLUDED.final_price,
         notes = EXCLUDED.notes
       RETURNING *`, [
        req.params.quotationId,
        line_items ? JSON.stringify(line_items) : null,
        leakType,
        normaliseScheduleOfWork(schedule_of_work),
        normaliseWarrantyText(warranty_text),
        final_price === undefined || final_price === null || final_price === "" ? null : Number(final_price),
        notes ?? null,
    ]);
    res.json(rows[0]);
}));
/** Approve into the reference library and the teaching set. */
reviewsRouter.post("/reviews/:quotationId/approve", requireAdmin, asyncHandler(async (req, res) => {
    const { add_photos_to_teaching_set } = req.body ?? {};
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query(`SELECT q.id, q.ref_no, q.line_items, q.total, q.schedule_of_work, q.warranty_text, q.inspection_id,
                r.line_items AS review_line_items, r.leak_type AS review_leak_type,
                r.schedule_of_work AS review_schedule_of_work, r.warranty_text AS review_warranty_text,
                r.final_price AS review_final_price
         FROM quotations q
         LEFT JOIN quotation_reviews r ON r.quotation_id = q.id
         WHERE q.id = $1 FOR UPDATE OF q`, [req.params.quotationId]);
        if (rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Quotation not found" });
        }
        const quotation = rows[0];
        const values = effective(quotation);
        const { rows: reviewRows } = await client.query(`INSERT INTO quotation_reviews (quotation_id, status, reviewed_by, reviewed_at)
         VALUES ($1, 'approved', $2, now())
         ON CONFLICT (quotation_id) DO UPDATE
           SET status = 'approved', reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now()
         RETURNING id`, [quotation.id, req.session.userId ?? null]);
        const reviewId = reviewRows[0].id;
        const added = await promoteToLibrary(client, {
            quotationId: quotation.id,
            inspectionId: quotation.inspection_id,
            refNo: quotation.ref_no,
            lineItems: values.lineItems,
            finalPrice: values.finalPrice,
            scheduleOfWork: values.scheduleOfWork,
            warrantyText: values.warrantyText,
            leakTypeOverride: values.leakType,
            reviewId,
        });
        // The teaching set is a separate opt-in: a job worth pricing from is
        // not automatically a photo worth showing the model.
        //
        // Labels only here. Reviewing is a bulk action over somebody else's
        // work, and the photographs have not necessarily been looked at one
        // by one — an administrator approving their own job can choose to
        // include the images.
        const taught = add_photos_to_teaching_set
            ? await addPhotosToTeachingSet(client, {
                inspectionId: quotation.inspection_id,
                sourceLabel: quotation.ref_no ?? `quotation ${quotation.id}`,
                leakTypeOverride: values.leakType,
                userId: req.session.userId,
                useImage: false,
            })
            : 0;
        await client.query("COMMIT");
        res.json({ ok: true, library_rows: added, review_id: reviewId, teaching_examples: taught });
    }
    catch (err) {
        await client.query("ROLLBACK");
        throw err;
    }
    finally {
        client.release();
    }
}));
/** Keep it out of the library — and remove anything a previous approval added. */
reviewsRouter.post("/reviews/:quotationId/reject", requireAdmin, asyncHandler(async (req, res) => {
    const { notes } = req.body ?? {};
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("DELETE FROM quotation_library WHERE quotation_id = $1", [req.params.quotationId]);
        const { rows } = await client.query(`INSERT INTO quotation_reviews (quotation_id, status, notes, reviewed_by, reviewed_at)
         VALUES ($1, 'rejected', $2, $3, now())
         ON CONFLICT (quotation_id) DO UPDATE
           SET status = 'rejected', notes = EXCLUDED.notes,
               reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now()
         RETURNING *`, [req.params.quotationId, notes ?? null, req.session.userId ?? null]);
        await client.query("COMMIT");
        res.json(rows[0]);
    }
    catch (err) {
        await client.query("ROLLBACK");
        throw err;
    }
    finally {
        client.release();
    }
}));
/**
 * How many quotations are waiting for review.
 *
 * Its own path rather than /reviews/count, which would be ambiguous with
 * /reviews/:quotationId and depend on the order routes happen to be
 * registered in. Called from the top bar on every page, so it stays a single
 * count rather than fetching the queue.
 */
reviewsRouter.get("/review-queue/count", requireAdmin, asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`SELECT count(*)::int AS pending
       FROM quotations q
       JOIN inspections i ON i.id = q.inspection_id
       LEFT JOIN users u ON u.id = COALESCE(q.prepared_by, i.created_by)
       LEFT JOIN quotation_reviews r ON r.quotation_id = q.id
       WHERE COALESCE(u.role, 'user') = 'user'
         AND COALESCE(r.status, 'pending') = 'pending'`);
    res.json({ pending: rows[0].pending });
}));
