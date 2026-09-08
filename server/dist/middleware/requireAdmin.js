import { pool } from "../db/pool.js";
/**
 * Gates the endpoints that change what the model learns from.
 *
 * Enforced on the server rather than by hiding links: the browser can call
 * these directly, and the whole point of the restriction is that an
 * untrained salesperson cannot feed the model inaccurate history.
 */
export async function requireAdmin(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
    }
    try {
        const { rows } = await pool.query("SELECT role FROM users WHERE id = $1", [req.session.userId]);
        if (rows[0]?.role !== "admin" && rows[0]?.role !== "superadmin") {
            return res.status(403).json({ error: "This action is restricted to administrators." });
        }
        next();
    }
    catch (err) {
        next(err);
    }
}
/** Whether the signed-in user is an administrator, for endpoints that vary by role. */
export async function isAdmin(userId) {
    if (!userId)
        return false;
    const { rows } = await pool.query("SELECT role FROM users WHERE id = $1", [userId]);
    return rows[0]?.role === "admin" || rows[0]?.role === "superadmin";
}
/** Superadmin only — the cross-team visibility that ordinary admins don't get. */
export async function requireSuperAdmin(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
    }
    try {
        const { rows } = await pool.query("SELECT role FROM users WHERE id = $1", [req.session.userId]);
        if (rows[0]?.role !== "superadmin") {
            return res.status(403).json({ error: "This view is restricted to the super administrator." });
        }
        next();
    }
    catch (err) {
        next(err);
    }
}
/**
 * Gates the invoicing endpoints.
 *
 * Accounts is a role beside sales, not above it: it carries no access to the
 * sales workspace — no photographs, no assessments, no pricing library — and
 * sales carry no access to invoices. The super administrator passes too,
 * since somebody has to be able to see both halves.
 *
 * Ordinary administrators are deliberately excluded: their role is about
 * what the model learns from, which has nothing to do with billing.
 */
export async function requireAccounts(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
    }
    try {
        const { rows } = await pool.query("SELECT role FROM users WHERE id = $1", [req.session.userId]);
        if (rows[0]?.role !== "accounts" && rows[0]?.role !== "superadmin") {
            return res.status(403).json({ error: "This section is for the accounts team." });
        }
        next();
    }
    catch (err) {
        next(err);
    }
}
