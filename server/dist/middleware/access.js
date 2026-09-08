import { pool } from "../db/pool.js";
/**
 * Ownership rules for inspections and everything hanging off them.
 *
 * Everyone — user, admin and superadmin alike — sees only their own jobs in
 * the ordinary screens. Other people's work is reached deliberately, through
 * Review (an administrator checking users' quotations) or All Quotations (a
 * superadmin), both of which are separate, separately-guarded endpoints.
 *
 * Enforced here rather than by filtering in the UI: the row ids are
 * sequential and guessable, so an ownership check that only exists in the
 * browser is not a check at all.
 */
export async function getRole(userId) {
    if (!userId)
        return null;
    const { rows } = await pool.query("SELECT role FROM users WHERE id = $1", [userId]);
    return rows[0]?.role ?? null;
}
/**
 * Elevated means "may see other people's sales work" — deliberately not
 * accounts, who sit alongside sales rather than above them. Accounts reach
 * jobs through the invoicing endpoints, which carry their own guard and
 * expose only what an invoice needs.
 */
export function isElevated(role) {
    return role === "admin" || role === "superadmin";
}
/** Resolves the owning inspection for whichever kind of id a route carries. */
const OWNER_QUERIES = {
    inspection: "SELECT created_by FROM inspections WHERE id = $1",
    quotation: "SELECT i.created_by FROM quotations q JOIN inspections i ON i.id = q.inspection_id WHERE q.id = $1",
    area: "SELECT i.created_by FROM inspection_areas a JOIN inspections i ON i.id = a.inspection_id WHERE a.id = $1",
    photo: "SELECT i.created_by FROM photos p JOIN inspections i ON i.id = p.inspection_id WHERE p.id = $1",
};
export async function ownerOf(resource, id) {
    const { rows } = await pool.query(OWNER_QUERIES[resource], [id]);
    return rows.length === 0 ? undefined : rows[0].created_by;
}
/**
 * Guards a route against reading or changing someone else's job.
 *
 * A superadmin passes: the All Quotations view links straight into the
 * ordinary quotation and inspection screens, so the same routes serve it.
 * An admin does NOT pass — they review other people's work through the
 * review endpoints, which carry their own guard and their own read-only
 * view of the quotation.
 */
export function requireOwnership(resource, param) {
    return async (req, res, next) => {
        try {
            const role = await getRole(req.session.userId);
            if (!role)
                return res.status(401).json({ error: "Not authenticated" });
            if (role === "superadmin")
                return next();
            const owner = await ownerOf(resource, req.params[param]);
            if (owner === undefined)
                return res.status(404).json({ error: `${resource} not found` });
            if (owner !== req.session.userId) {
                return res.status(403).json({ error: "This belongs to another salesperson." });
            }
            next();
        }
        catch (err) {
            next(err);
        }
    };
}
