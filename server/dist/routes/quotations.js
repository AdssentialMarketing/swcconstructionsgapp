import { Router } from "express";
import { pool } from "../db/pool.js";
import { draftQuotation } from "../services/claudeQuotation.js";
import { exportQuotationExcel } from "../services/excelExport.js";
import { bumpRefNoFloor, getNextRefNo, initialsForUser, parseRefNo } from "../services/refNumber.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { normaliseScheduleOfWork, normaliseWarrantyText } from "../services/quotationTerms.js";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { requireOwnership, getRole, isElevated } from "../middleware/access.js";
import { DEFAULT_LAST_ITEM_DESCRIPTION, MANDATORY_FIRST_ITEM_DESCRIPTION, } from "../services/standardLineItems.js";
import { findCommonTermsOverall } from "../services/retrieval.js";
import { promoteToLibrary } from "../services/libraryPromotion.js";
import { ConverterMissingError, convertXlsxToPdf } from "../services/pdfExport.js";
import { deleteQuotation, previewQuotationDeletion } from "../services/quotationDeletion.js";
import { requireSuperAdmin } from "../middleware/requireAdmin.js";
import { recordAudit } from "../services/audit.js";
import { addPhotosToTeachingSet } from "../services/teachingSetPromotion.js";
export const quotationsRouter = Router();
function computeTotals(lineItems, taxRate) {
    const subtotal = lineItems.reduce((sum, item) => sum + item.total, 0);
    const taxAmount = +(subtotal * (taxRate / 100)).toFixed(2);
    const total = +(subtotal + taxAmount).toFixed(2);
    return { subtotal: +subtotal.toFixed(2), taxAmount, total };
}
// Draft a quotation from an inspection's photo analyses + historical reference.
// This does NOT persist anything to `quotations` yet — it's a preview the
// salesperson reviews/edits before saving.
quotationsRouter.post("/inspections/:inspectionId/draft", requireOwnership("inspection", "inspectionId"), asyncHandler(async (req, res) => {
    // A salesperson's correction wins over the model's own answer: it is the
    // assessment the quotation should actually be priced from, and it is what
    // drives leak_type retrieval against the historical library.
    // The chosen repair method rides along inside the analysis, so everything
    // downstream — retrieval, the prompt, the library — sees which of the
    // workable methods this customer actually agreed to.
    const photosResult = await pool.query(`SELECT COALESCE(corrected_analysis, ai_analysis)
                || jsonb_build_object('chosen_method', to_jsonb(selected_repair_method)) AS analysis
       FROM photos
       WHERE inspection_id = $1 AND COALESCE(corrected_analysis, ai_analysis) IS NOT NULL`, [req.params.inspectionId]);
    if (photosResult.rows.length === 0) {
        return res.status(400).json({ error: "No analyzed photos found for this inspection yet" });
    }
    const analyses = photosResult.rows.map((r) => r.analysis);
    // Grouped by area so the draft can carry one line item per area. Photos
    // uploaded before areas existed have no area_id and are collected under
    // a single unnamed group, which drafts as it always did.
    const areasResult = await pool.query(`SELECT a.name,
              json_agg(
                COALESCE(p.corrected_analysis, p.ai_analysis)
                  || jsonb_build_object('chosen_method', to_jsonb(p.selected_repair_method))
                ORDER BY p.id
              ) AS analyses
       FROM photos p
       LEFT JOIN inspection_areas a ON a.id = p.area_id
       WHERE p.inspection_id = $1 AND COALESCE(p.corrected_analysis, p.ai_analysis) IS NOT NULL
       GROUP BY a.id, a.name, a.position
       ORDER BY a.position NULLS FIRST, a.id NULLS FIRST`, [req.params.inspectionId]);
    const areas = areasResult.rows.filter((row) => row.name !== null);
    // Property type steers which references rank first and which
    // preferential rate is applied to the drafted prices.
    const { rows: site } = await pool.query("SELECT property_type FROM inspections WHERE id = $1", [
        req.params.inspectionId,
    ]);
    const draft = await draftQuotation(analyses, areas, site[0]?.property_type ?? null);
    res.json(draft);
}));
/**
 * Inserts a quotation and claims the next reference number for it.
 *
 * Shared by the two ways one gets created — saving an AI draft, and starting
 * an empty one by hand — so both claim their ref number, record their
 * preparer and flip the inspection to "quoted" identically.
 */
async function insertQuotation(inspectionId, userId, payload) {
    const rate = Number(payload.tax_rate ?? 0);
    const { subtotal, taxAmount, total } = computeTotals(payload.line_items, rate);
    // The ref number ends in the preparer's initials, and who prepared it is
    // stored rather than looked up later — re-exporting an old quotation
    // must keep the name, signature and ref number of whoever wrote it.
    const { rows: preparer } = await pool.query("SELECT name, initials FROM users WHERE id = $1", [userId]);
    const refNo = await getNextRefNo(preparer[0] ? initialsForUser(preparer[0]) : undefined);
    const result = await pool.query(`INSERT INTO quotations (inspection_id, line_items, currency, subtotal, tax_rate, tax_amount, total, ref_no, schedule_of_work, warranty_text, prepared_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`, [
        inspectionId,
        JSON.stringify(payload.line_items),
        payload.currency ?? "SGD",
        subtotal,
        rate,
        taxAmount,
        total,
        refNo,
        normaliseScheduleOfWork(payload.schedule_of_work),
        normaliseWarrantyText(payload.warranty_text),
        userId ?? null,
    ]);
    await pool.query("UPDATE inspections SET status = 'quoted' WHERE id = $1", [inspectionId]);
    return result.rows[0];
}
// Save a (possibly edited) quotation for an inspection as a draft.
quotationsRouter.post("/inspections/:inspectionId/quotations", requireOwnership("inspection", "inspectionId"), asyncHandler(async (req, res) => {
    const { line_items, currency, tax_rate, schedule_of_work, warranty_text } = req.body ?? {};
    if (!Array.isArray(line_items)) {
        return res.status(400).json({ error: "line_items must be an array" });
    }
    const quotation = await insertQuotation(req.params.inspectionId, req.session.userId, {
        line_items,
        currency,
        tax_rate,
        schedule_of_work,
        warranty_text,
    });
    res.status(201).json(quotation);
}));
// Start an empty quotation, with no photos and no model involved.
//
// Not every job needs an assessment: some are quoted from a phone call or a
// site visit the salesperson already understands, and testing the quotation
// side shouldn't require uploading photos first. So this skips analysis
// entirely and opens the editor on a blank sheet.
//
// "Blank" still means the two standing items and the team's usual terms —
// the same starting point an AI draft produces, minus the priced scope —
// because those are company rules rather than anything the model decided.
quotationsRouter.post("/inspections/:inspectionId/quotations/blank", requireOwnership("inspection", "inspectionId"), asyncHandler(async (req, res) => {
    const lineItems = [
        {
            description: MANDATORY_FIRST_ITEM_DESCRIPTION,
            quantity: 1,
            unit: "LS",
            unit_price: 0,
            total: 0,
        },
        {
            description: DEFAULT_LAST_ITEM_DESCRIPTION,
            quantity: 1,
            unit: "LS",
            unit_price: 0,
            total: 0,
        },
    ];
    // The most common past wording, so a manual quotation starts from the
    // team's usual terms rather than two empty fields. Both stay editable.
    const terms = await findCommonTermsOverall();
    const quotation = await insertQuotation(req.params.inspectionId, req.session.userId, {
        line_items: lineItems,
        currency: "SGD",
        tax_rate: 0,
        schedule_of_work: terms.schedule[0]?.value ?? null,
        warranty_text: terms.warranty[0]?.value ?? null,
    });
    res.status(201).json(quotation);
}));
// Update line items / rates on an existing draft quotation.
quotationsRouter.put("/quotations/:id", requireOwnership("quotation", "id"), asyncHandler(async (req, res) => {
    const { line_items, currency, tax_rate, ref_no, schedule_of_work, warranty_text } = req.body ?? {};
    if (!Array.isArray(line_items)) {
        return res.status(400).json({ error: "line_items must be an array" });
    }
    const rate = Number(tax_rate ?? 0);
    const { subtotal, taxAmount, total } = computeTotals(line_items, rate);
    const refNo = typeof ref_no === "string" && ref_no.trim() !== "" ? ref_no.trim().toUpperCase() : null;
    let result;
    try {
        result = await pool.query(`UPDATE quotations SET line_items = $1, currency = $2, subtotal = $3, tax_rate = $4, tax_amount = $5, total = $6,
                ref_no = COALESCE($7, ref_no), schedule_of_work = $8, warranty_text = $9,
                updated_at = now()
         WHERE id = $10 RETURNING *`, [
            JSON.stringify(line_items),
            currency ?? "SGD",
            subtotal,
            rate,
            taxAmount,
            total,
            refNo,
            normaliseScheduleOfWork(schedule_of_work),
            normaliseWarrantyText(warranty_text),
            req.params.id,
        ]);
    }
    catch (err) {
        // ref_no is unique across the company, so typing one that has already
        // been used is a real mistake worth naming rather than a 500.
        if (err.code === "23505") {
            return res.status(409).json({ error: `Reference number ${refNo} is already used by another quotation.` });
        }
        throw err;
    }
    if (result.rows.length === 0) {
        return res.status(404).json({ error: "Quotation not found" });
    }
    // A salesperson typing their own number is telling us where their series
    // has actually reached — they may have written quotations by hand on
    // site, outside the app, and those numbers are already spent. Move their
    // floor up so the next generated number carries on from it instead of
    // colliding with something already issued.
    //
    // Only ever raised, never lowered: correcting a typo downwards must not
    // hand out a number that has already gone to a customer.
    //
    // A revision ("SWC26083SS-2", written when a client asks for changes
    // after the quotation went out) deliberately keeps the base number so
    // both documents read as the same project. It therefore moves the floor
    // to 83 — exactly where the original put it — and burns no new number.
    const parsedRef = refNo ? parseRefNo(refNo) : null;
    if (parsedRef) {
        await bumpRefNoFloor(parsedRef.year, parsedRef.sequence, parsedRef.initials);
    }
    res.json(result.rows[0]);
}));
quotationsRouter.get("/quotations/:id", requireOwnership("quotation", "id"), asyncHandler(async (req, res) => {
    const built = await rebuildExcel(req.params.id);
    if (!built)
        return res.status(404).json({ error: "Quotation not found" });
    res.json(built.quotation);
}));
/**
 * Converts the quotation to PDF, from a freshly rebuilt workbook.
 *
 * The .xlsx is regenerated first rather than converting whatever is on disk:
 * an export made before the last edit would otherwise be handed to the
 * customer as a PDF of a quotation that no longer exists.
 */
quotationsRouter.post("/quotations/:id/export-pdf", requireOwnership("quotation", "id"), asyncHandler(async (req, res) => {
    const built = await rebuildExcel(req.params.id);
    if (!built)
        return res.status(404).json({ error: "Quotation not found" });
    let pdfAbsolute;
    try {
        pdfAbsolute = await convertXlsxToPdf(path.join(process.cwd(), built.excelPath));
    }
    catch (err) {
        if (err instanceof ConverterMissingError) {
            // Not the salesperson's fault and not fixable by retrying, so it is
            // reported as a server problem with the fix spelled out.
            return res.status(503).json({ error: err.message });
        }
        throw err;
    }
    const pdfPath = path.relative(process.cwd(), pdfAbsolute);
    // The filename tracks the reference number and address, so an earlier
    // PDF under a previous name would otherwise linger in exports/.
    const previous = built.quotation.pdf_path;
    if (previous && previous !== pdfPath) {
        await unlink(path.join(process.cwd(), previous)).catch(() => { });
    }
    const updated = await pool.query("UPDATE quotations SET pdf_path = $1 WHERE id = $2 RETURNING *", [
        pdfPath,
        req.params.id,
    ]);
    res.json(updated.rows[0]);
}));
/**
 * Regenerates the workbook for one quotation from its current data.
 *
 * Shared by both exports so the .xlsx and the PDF can never disagree about
 * what the quotation says.
 */
async function rebuildExcel(quotationId) {
    const result = await pool.query(`SELECT q.*, i.company_name, i.site_address, i.postal_code, i.contact_name, i.inspection_date,
            u.name AS prepared_by_name, u.signature_path AS prepared_by_signature
     FROM quotations q
     JOIN inspections i ON i.id = q.inspection_id
     -- Falls back to whoever created the inspection: quotations drafted
     -- before prepared_by existed have none, and without this they export
     -- with no name and no signature even though the account has both.
     LEFT JOIN users u ON u.id = COALESCE(q.prepared_by, i.created_by)
     WHERE q.id = $1`, [quotationId]);
    const quotation = result.rows[0];
    if (!quotation)
        return null;
    const excelPath = await exportQuotationExcel({
        quotationId: quotation.id,
        refNo: quotation.ref_no,
        companyName: quotation.company_name,
        siteAddress: quotation.site_address,
        postalCode: quotation.postal_code,
        contactName: quotation.contact_name,
        inspectionDate: new Date(quotation.inspection_date).toISOString().slice(0, 10),
        lineItems: quotation.line_items,
        currency: quotation.currency,
        subtotal: Number(quotation.subtotal),
        taxRate: Number(quotation.tax_rate),
        taxAmount: Number(quotation.tax_amount),
        total: Number(quotation.total),
        scheduleOfWork: quotation.schedule_of_work,
        warrantyText: quotation.warranty_text,
        preparedByName: quotation.prepared_by_name ?? null,
        signaturePath: quotation.prepared_by_signature ?? null,
    });
    // The filename is derived from the ref number and address, so editing
    // either leaves the previous export orphaned in exports/ — remove it
    // rather than accumulating stale files under old names.
    if (quotation.excel_path && quotation.excel_path !== excelPath) {
        await unlink(path.join(process.cwd(), quotation.excel_path)).catch(() => { });
    }
    const updated = await pool.query("UPDATE quotations SET excel_path = $1 WHERE id = $2 RETURNING *", [
        excelPath,
        quotationId,
    ]);
    return { excelPath, quotation: updated.rows[0] };
}
// Approve a quotation: mark it approved and save photo + final line items +
// price into the reference library for future retrieval.
/**
 * What deleting this quotation would take with it. Shown before the fact,
 * because a library entry removed is pricing the model no longer learns from.
 */
quotationsRouter.get("/quotations/:id/deletion-preview", requireSuperAdmin, asyncHandler(async (req, res) => {
    const preview = await previewQuotationDeletion(Number(req.params.id));
    if (!preview)
        return res.status(404).json({ error: "Quotation not found" });
    res.json(preview);
}));
/**
 * Removes one quotation, leaving the job and its photos alone.
 *
 * Super administrators only, matching the rule everywhere else: a
 * salesperson archives what they no longer want, and only a super
 * administrator destroys anything. Deleting a whole inspection was
 * previously the only way to get rid of a wrong quotation, which threw away
 * the photos and every other version of the job with it.
 */
quotationsRouter.delete("/quotations/:id", requireSuperAdmin, asyncHandler(async (req, res) => {
    const removed = await deleteQuotation(Number(req.params.id));
    if (!removed)
        return res.status(404).json({ error: "Quotation not found" });
    // Written after the fact: the audit row has to outlive the record, which
    // is exactly why the reference number is copied into the log.
    await recordAudit({
        actorId: req.session.userId,
        action: "delete",
        entityType: "quotation",
        entityId: Number(req.params.id),
        entityLabel: removed.ref_no ?? `quotation ${req.params.id}`,
        detail: removed,
    });
    res.json({ ok: true, removed });
}));
/**
 * Hands a job over to accounts for billing.
 *
 * The only thing that crosses between sales and accounts. Sales say when the
 * work is done; accounts decide what to bill and when. Owner-only, like
 * everything else a salesperson does to their own job.
 */
quotationsRouter.post("/quotations/:id/ready-to-invoice", requireOwnership("quotation", "id"), asyncHandler(async (req, res) => {
    const ready = req.body?.ready !== false;
    const { rows } = await pool.query(`UPDATE quotations
          SET ready_to_invoice_at = CASE WHEN $1::boolean THEN now() ELSE NULL END,
              ready_to_invoice_by = CASE WHEN $1::boolean THEN $2::integer ELSE NULL END
        WHERE id = $3
        RETURNING *`, [ready, req.session.userId ?? null, req.params.id]);
    if (rows.length === 0)
        return res.status(404).json({ error: "Quotation not found" });
    // Withdrawing it once accounts have raised an invoice would leave the
    // job looking un-billed while an invoice exists for it.
    if (!ready) {
        const { rows: invoiced } = await pool.query("SELECT 1 FROM invoices WHERE quotation_id = $1", [
            req.params.id,
        ]);
        if (invoiced.length > 0) {
            await pool.query("UPDATE quotations SET ready_to_invoice_at = now(), ready_to_invoice_by = $1 WHERE id = $2", [req.session.userId ?? null, req.params.id]);
            return res.status(409).json({ error: "Accounts have already raised an invoice for this job." });
        }
    }
    res.json(rows[0]);
}));
quotationsRouter.post("/quotations/:id/approve", requireOwnership("quotation", "id"), asyncHandler(async (req, res) => {
    const { add_photos_to_teaching_set } = req.body ?? {};
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const qResult = await client.query("SELECT * FROM quotations WHERE id = $1 FOR UPDATE", [req.params.id]);
        const quotation = qResult.rows[0];
        if (!quotation) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Quotation not found" });
        }
        const updated = await client.query("UPDATE quotations SET status = 'approved', approved_at = now() WHERE id = $1 RETURNING *", [req.params.id]);
        await client.query("UPDATE inspections SET status = 'approved' WHERE id = $1", [quotation.inspection_id]);
        // Where an approval goes depends on who made it. An administrator is
        // trusted to teach the model from their own work, so it lands in the
        // library immediately. A salesperson's is queued for an administrator
        // to check first — that is the extra step that keeps unverified
        // pricing and wording out of what the model learns from.
        let taught = 0;
        const role = await getRole(req.session.userId);
        if (isElevated(role)) {
            await promoteToLibrary(client, {
                quotationId: quotation.id,
                inspectionId: quotation.inspection_id,
                refNo: quotation.ref_no,
                lineItems: quotation.line_items,
                finalPrice: Number(quotation.total),
                scheduleOfWork: quotation.schedule_of_work,
                warrantyText: quotation.warranty_text,
            });
            // Recorded as reviewed so it doesn't also appear in the queue.
            await client.query(`INSERT INTO quotation_reviews (quotation_id, status, reviewed_by, reviewed_at)
           VALUES ($1, 'approved', $2, now())
           ON CONFLICT (quotation_id) DO UPDATE
             SET status = 'approved', reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now()`, [quotation.id, req.session.userId ?? null]);
            // Because an administrator's approval never enters the review queue,
            // this is their only chance to teach the model from the job — the
            // queue is where that choice used to live, and skipping it meant
            // their own photos could never reach the teaching set at all.
            //
            // With the image, unlike the Review path: this is the administrator's
            // own job, whose photographs they have just been through.
            if (add_photos_to_teaching_set) {
                taught = await addPhotosToTeachingSet(client, {
                    inspectionId: quotation.inspection_id,
                    sourceLabel: quotation.ref_no ?? `quotation ${quotation.id}`,
                    userId: req.session.userId,
                    useImage: true,
                });
            }
        }
        else {
            await client.query(`INSERT INTO quotation_reviews (quotation_id, status) VALUES ($1, 'pending')
           ON CONFLICT (quotation_id) DO NOTHING`, [quotation.id]);
        }
        await client.query("COMMIT");
        res.json({ ...updated.rows[0], teaching_examples: taught });
    }
    catch (err) {
        await client.query("ROLLBACK");
        throw err;
    }
    finally {
        client.release();
    }
}));
