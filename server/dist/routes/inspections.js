import { Router } from "express";
import { pool } from "../db/pool.js";
import { isPropertyType } from "../services/pricingAdjustments.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireOwnership } from "../middleware/access.js";
import { deleteInspection, previewInspectionDeletion } from "../services/inspectionDeletion.js";
import { requireSuperAdmin } from "../middleware/requireAdmin.js";
import { recordAudit } from "../services/audit.js";
export const inspectionsRouter = Router();
inspectionsRouter.get("/", asyncHandler(async (req, res) => {
    const result = await pool.query(
    // The latest quotation comes along so the list can link straight to it:
    // once a quotation exists it is what the salesperson wants to open,
    // not the photo page they already finished with.
    `SELECT i.id, i.created_by, i.company_name, i.site_address, i.postal_code, i.contact_name,
              i.reported_issue, i.inspection_date, i.status, i.created_at,
              i.archived_at, i.excluded_from_library,
              q.latest_quotation_id, q.latest_ref_no,
              COALESCE(q.quotation_count, 0)::int AS quotation_count
       FROM inspections i
       LEFT JOIN (
         SELECT inspection_id,
                (ARRAY_AGG(id ORDER BY created_at DESC, id DESC))[1] AS latest_quotation_id,
                (ARRAY_AGG(ref_no ORDER BY created_at DESC, id DESC))[1] AS latest_ref_no,
                COUNT(*) AS quotation_count
         FROM quotations WHERE archived_at IS NULL GROUP BY inspection_id
       ) q ON q.inspection_id = i.id
       -- Everyone sees only their own jobs here, superadmins included; the
       -- All Quotations tab is where everything is visible. Archived jobs are
       -- hidden unless asked for, which is the whole point of archiving.
       WHERE i.created_by = $1
         AND ($2::boolean OR i.archived_at IS NULL)
       ORDER BY i.archived_at DESC NULLS LAST, i.created_at DESC`, [req.session.userId, req.query.include_archived === "true"]);
    res.json(result.rows);
}));
inspectionsRouter.post("/", asyncHandler(async (req, res) => {
    const { site_address, company_name, postal_code, contact_name, reported_issue, inspection_date, property_type } = req.body ?? {};
    // company_name is optional: without it the quotation is addressed
    // straight to the property (address on line 1, postal code on line 2).
    if (!site_address || !postal_code) {
        return res.status(400).json({ error: "site_address and postal_code are required" });
    }
    if (property_type !== undefined && property_type !== null && !isPropertyType(property_type)) {
        return res.status(400).json({ error: "Unknown property type" });
    }
    const result = await pool.query(`INSERT INTO inspections
         (created_by, company_name, site_address, postal_code, contact_name, reported_issue, inspection_date,
          property_type)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, CURRENT_DATE), $8)
       RETURNING *`, [
        req.session.userId,
        company_name?.trim() || null,
        site_address,
        postal_code,
        contact_name ?? null,
        reported_issue?.trim() || null,
        inspection_date ?? null,
        property_type ?? null,
    ]);
    res.status(201).json(result.rows[0]);
}));
/**
 * Correct the site and client details after the fact.
 *
 * These are entered at the very start of a job, before anyone has looked at
 * a photo, so a typo in the address or a missing unit number is common and
 * currently permanent. They print on the quotation letterhead and drive the
 * export filename, so they have to stay editable.
 */
inspectionsRouter.put("/:id", requireOwnership("inspection", "id"), asyncHandler(async (req, res) => {
    const { company_name, site_address, postal_code, contact_name, reported_issue, inspection_date, property_type } = req.body ?? {};
    if (property_type !== undefined && property_type !== null && !isPropertyType(property_type)) {
        return res.status(400).json({ error: "Unknown property type" });
    }
    if (site_address !== undefined && (typeof site_address !== "string" || site_address.trim() === "")) {
        return res.status(400).json({ error: "Site address cannot be empty" });
    }
    if (postal_code !== undefined && (typeof postal_code !== "string" || postal_code.trim() === "")) {
        return res.status(400).json({ error: "Postal code cannot be empty" });
    }
    const { rows } = await pool.query(`UPDATE inspections
       SET company_name    = CASE WHEN $1::boolean THEN $2 ELSE company_name END,
           site_address    = COALESCE($3, site_address),
           postal_code     = COALESCE($4, postal_code),
           contact_name    = CASE WHEN $5::boolean THEN $6 ELSE contact_name END,
           reported_issue  = CASE WHEN $7::boolean THEN $8 ELSE reported_issue END,
           inspection_date = COALESCE($9, inspection_date),
           property_type   = CASE WHEN $10::boolean THEN $11 ELSE property_type END
       WHERE id = $12
       RETURNING *`, [
        // Sent-but-blank clears the field; absent leaves it alone. A plain
        // COALESCE could not tell those apart, and both are meaningful here:
        // a company name or Attn line is legitimately removed sometimes.
        company_name !== undefined,
        company_name?.trim() || null,
        site_address?.trim() ?? null,
        postal_code?.trim() ?? null,
        contact_name !== undefined,
        contact_name?.trim() || null,
        reported_issue !== undefined,
        reported_issue?.trim() || null,
        inspection_date ?? null,
        property_type !== undefined,
        property_type ?? null,
        req.params.id,
    ]);
    if (rows.length === 0)
        return res.status(404).json({ error: "Inspection not found" });
    // Library rows carry the property type of the job they came from, so a
    // correction here has to reach the ones already promoted — otherwise the
    // library goes on recommending this job as a reference for the wrong
    // kind of property. Exact, not guessed: it is the same answer, copied.
    if (property_type !== undefined) {
        await pool.query(`UPDATE quotation_library l
            SET site_type = $1
           FROM quotations q
          WHERE q.id = l.quotation_id AND q.inspection_id = $2`, [property_type ?? null, req.params.id]);
    }
    res.json(rows[0]);
}));
inspectionsRouter.get("/:id", requireOwnership("inspection", "id"), asyncHandler(async (req, res) => {
    const inspectionResult = await pool.query("SELECT * FROM inspections WHERE id = $1", [req.params.id]);
    const inspection = inspectionResult.rows[0];
    if (!inspection) {
        return res.status(404).json({ error: "Inspection not found" });
    }
    const photosResult = await pool.query(`SELECT id, file_path, original_name, mime_type, uploaded_at, ai_analysis,
              corrected_analysis, corrected_at, selected_repair_method
       FROM photos WHERE inspection_id = $1 ORDER BY uploaded_at`, [req.params.id]);
    const quotationsResult = await pool.query(`SELECT id, ref_no, status, total, currency, created_at, archived_at
       FROM quotations WHERE inspection_id = $1 ORDER BY created_at DESC`, [req.params.id]);
    res.json({ ...inspection, photos: photosResult.rows, quotations: quotationsResult.rows });
}));
/** What a delete would take with it, so the confirmation can be specific. */
inspectionsRouter.get("/:id/deletion-preview", requireOwnership("inspection", "id"), asyncHandler(async (req, res) => {
    const preview = await previewInspectionDeletion(Number(req.params.id));
    if (!preview)
        return res.status(404).json({ error: "Inspection not found" });
    res.json(preview);
}));
/**
 * Permanent deletion. Super administrator only.
 *
 * Everyone else archives instead: it clears their list without destroying
 * the photos, the quotation, or what the job taught the model — none of
 * which can be recovered once gone.
 */
inspectionsRouter.delete("/:id", requireSuperAdmin, asyncHandler(async (req, res) => {
    const label = (await pool.query("SELECT site_address FROM inspections WHERE id = $1", [req.params.id]))
        .rows[0]?.site_address;
    if (!label)
        return res.status(404).json({ error: "Inspection not found" });
    const removed = await deleteInspection(Number(req.params.id));
    if (!removed)
        return res.status(404).json({ error: "Inspection not found" });
    // Written after the fact rather than in the same transaction: the audit
    // row must survive the delete, and the record it describes is gone by
    // now, which is exactly why the label is copied into the log.
    await recordAudit({
        actorId: req.session.userId,
        action: "delete",
        entityType: "inspection",
        entityId: Number(req.params.id),
        entityLabel: label,
        detail: removed,
    });
    res.json({ ok: true, removed });
}));
