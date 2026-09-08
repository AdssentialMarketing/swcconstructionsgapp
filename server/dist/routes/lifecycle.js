import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireOwnership } from "../middleware/access.js";
import { requireAdmin, requireSuperAdmin } from "../middleware/requireAdmin.js";
import { listAudit, recordAudit } from "../services/audit.js";
export const lifecycleRouter = Router();
/**
 * Archiving, library exclusion, and the audit view.
 *
 * Archiving and excluding are deliberately separate endpoints on separate
 * columns: archiving is about whose screen a job appears on, excluding is
 * about whether the model may learn from it. Setting one has never any
 * effect on the other, so a finished job can stay out of the way while still
 * informing prices, and a mispriced one can stop teaching without vanishing
 * from its owner's list.
 *
 * Every route here acts on exactly one record. There is no bulk endpoint —
 * a salesperson tidying their list should have to look at each job as they
 * do it, and a multi-record call is also the one most likely to be pointed
 * at the wrong set.
 */
const LABELS = {
    quotation: "SELECT COALESCE(ref_no, 'Quotation #' || id) AS label FROM quotations WHERE id = $1",
    inspection: "SELECT site_address AS label FROM inspections WHERE id = $1",
};
async function labelFor(entity, id) {
    const { rows } = await pool.query(LABELS[entity], [id]);
    return rows[0]?.label ?? `#${id}`;
}
function lifecycleRoutes(entity, table) {
    const base = entity === "quotation" ? "/quotations" : "/inspections";
    lifecycleRouter.post(`${base}/:id/archive`, requireOwnership(entity, "id"), asyncHandler(async (req, res) => {
        const label = await labelFor(entity, req.params.id);
        const { rows } = await pool.query(`UPDATE ${table} SET archived_at = now(), archived_by = $1
         WHERE id = $2 AND archived_at IS NULL RETURNING id`, [req.session.userId ?? null, req.params.id]);
        // Already archived is not an error — the outcome the caller wanted holds.
        if (rows.length > 0) {
            await recordAudit({
                actorId: req.session.userId,
                action: "archive",
                entityType: entity,
                entityId: Number(req.params.id),
                entityLabel: label,
            });
        }
        res.json({ ok: true, archived: true });
    }));
    lifecycleRouter.post(`${base}/:id/restore`, requireOwnership(entity, "id"), asyncHandler(async (req, res) => {
        const label = await labelFor(entity, req.params.id);
        const { rows } = await pool.query(`UPDATE ${table} SET archived_at = NULL, archived_by = NULL
         WHERE id = $1 AND archived_at IS NOT NULL RETURNING id`, [req.params.id]);
        if (rows.length > 0) {
            await recordAudit({
                actorId: req.session.userId,
                action: "restore",
                entityType: entity,
                entityId: Number(req.params.id),
                entityLabel: label,
            });
        }
        res.json({ ok: true, archived: false });
    }));
    /**
     * Excluding decides what the model may learn from, so it sits with the
     * other training controls: administrators only. A salesperson archives to
     * tidy their own list, which is purely about visibility and touches
     * nothing the model reads.
     *
     * Ownership still applies on top, so an administrator changes this on
     * their own jobs and a super administrator on anyone's.
     */
    lifecycleRouter.put(`${base}/:id/library-exclusion`, requireAdmin, requireOwnership(entity, "id"), asyncHandler(async (req, res) => {
        const excluded = Boolean(req.body?.excluded);
        const label = await labelFor(entity, req.params.id);
        const { rows } = await pool.query(`UPDATE ${table} SET excluded_from_library = $1
         WHERE id = $2 AND excluded_from_library IS DISTINCT FROM $1 RETURNING id`, [excluded, req.params.id]);
        if (rows.length > 0) {
            await recordAudit({
                actorId: req.session.userId,
                action: excluded ? "exclude_from_library" : "include_in_library",
                entityType: entity,
                entityId: Number(req.params.id),
                entityLabel: label,
            });
        }
        res.json({ ok: true, excluded_from_library: excluded });
    }));
}
lifecycleRoutes("quotation", "quotations");
lifecycleRoutes("inspection", "inspections");
/**
 * Everything archived, across every user. Super administrator only — the
 * one place another person's archived work is visible, and the place it can
 * be brought back from.
 */
lifecycleRouter.get("/archived", requireSuperAdmin, asyncHandler(async (_req, res) => {
    const { rows: inspections } = await pool.query(`SELECT i.id, i.site_address, i.company_name, i.archived_at, i.excluded_from_library,
              owner.name AS owner_name, archiver.name AS archived_by_name,
              (SELECT count(*)::int FROM quotations q WHERE q.inspection_id = i.id) AS quotations,
              (SELECT q.ref_no FROM quotations q WHERE q.inspection_id = i.id
                ORDER BY q.created_at DESC, q.id DESC LIMIT 1) AS latest_ref_no
       FROM inspections i
       LEFT JOIN users owner ON owner.id = i.created_by
       LEFT JOIN users archiver ON archiver.id = i.archived_by
       WHERE i.archived_at IS NOT NULL
       ORDER BY i.archived_at DESC`);
    const { rows: quotations } = await pool.query(`SELECT q.id, q.ref_no, q.total, q.archived_at, q.excluded_from_library,
              i.site_address, owner.name AS owner_name, archiver.name AS archived_by_name
       FROM quotations q
       JOIN inspections i ON i.id = q.inspection_id
       LEFT JOIN users owner ON owner.id = COALESCE(q.prepared_by, i.created_by)
       LEFT JOIN users archiver ON archiver.id = q.archived_by
       WHERE q.archived_at IS NOT NULL
       ORDER BY q.archived_at DESC`);
    res.json({ inspections, quotations });
}));
/** The audit trail. Administrators and above. */
lifecycleRouter.get("/audit-log", requireAdmin, asyncHandler(async (req, res) => {
    const entity = req.query.entity === "quotation" || req.query.entity === "inspection" ? req.query.entity : undefined;
    res.json(await listAudit(Number(req.query.limit ?? 200), entity));
}));
