import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireSuperAdmin } from "../middleware/requireAdmin.js";
export const allQuotationsRouter = Router();
/**
 * Every inspection in the system, whoever it belongs to.
 *
 * The ordinary Inspections list is deliberately scoped to the signed-in
 * salesperson — including for a superadmin, so their own screen stays about
 * their own work. This is the one place the whole company's jobs are
 * visible, which is why it carries the owner's name on every row.
 */
allQuotationsRouter.get("/all-quotations", requireSuperAdmin, asyncHandler(async (req, res) => {
    const owner = req.query.owner ? Number(req.query.owner) : null;
    const { rows } = await pool.query(`SELECT i.id AS inspection_id, i.company_name, i.site_address, i.postal_code,
              i.status, i.inspection_date, i.created_at,
              u.id AS owner_id, u.name AS owner_name, u.role AS owner_role,
              q.latest_quotation_id, COALESCE(q.quotation_count, 0)::int AS quotation_count,
              q.latest_ref_no, q.latest_total,
              -- Every quotation for the job, not just the newest. Drafting a
              -- second one used to make the first unreachable: the row linked
              -- to the latest and showed a "+1" badge for the others that
              -- went nowhere.
              COALESCE(all_q.quotations, '[]'::json) AS quotations,
              (SELECT COUNT(*)::int FROM photos p WHERE p.inspection_id = i.id) AS photo_count,
              r.status AS review_status
       FROM inspections i
       LEFT JOIN users u ON u.id = i.created_by
       LEFT JOIN (
         SELECT DISTINCT ON (inspection_id)
                inspection_id, id AS latest_quotation_id, ref_no AS latest_ref_no, total AS latest_total,
                COUNT(*) OVER (PARTITION BY inspection_id) AS quotation_count
         FROM quotations
         ORDER BY inspection_id, created_at DESC, id DESC
       ) q ON q.inspection_id = i.id
       LEFT JOIN (
         SELECT inspection_id,
                json_agg(json_build_object(
                  'id', id, 'ref_no', ref_no, 'status', status, 'total', total,
                  'created_at', created_at, 'archived_at', archived_at
                ) ORDER BY created_at DESC, id DESC) AS quotations
         FROM quotations GROUP BY inspection_id
       ) all_q ON all_q.inspection_id = i.id
       LEFT JOIN quotation_reviews r ON r.quotation_id = q.latest_quotation_id
       WHERE $1::int IS NULL OR u.id = $1
       ORDER BY i.created_at DESC`, [owner]);
    res.json(rows);
}));
/** The people who own jobs, for the owner filter. */
allQuotationsRouter.get("/all-quotations/owners", requireSuperAdmin, asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`SELECT u.id, u.name, u.role, COUNT(i.id)::int AS inspection_count
       FROM users u LEFT JOIN inspections i ON i.created_by = u.id
       GROUP BY u.id ORDER BY u.name`);
    res.json(rows);
}));
