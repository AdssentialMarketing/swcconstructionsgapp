import { Router } from "express";
import bcrypt from "bcrypt";
import { pool } from "../db/pool.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { initialsForUser } from "../services/refNumber.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
export const usersRouter = Router();
// "accounts" is a role beside sales rather than above it: invoicing only,
// with no access to the sales workspace. "superadmin" is deliberately absent
// — it is the account that grants every other role.
const ROLES = new Set(["admin", "accounts", "user"]);
const MIN_PASSWORD_LENGTH = 8;
function present(user) {
    return { ...user, effective_initials: initialsForUser(user) };
}
usersRouter.get("/users", requireAdmin, asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`SELECT u.id, u.name, u.email, u.role, u.initials, u.created_at,
              u.signature_path IS NOT NULL AS has_signature,
              (SELECT COUNT(*)::int FROM quotations q WHERE q.prepared_by = u.id) AS quotation_count
       FROM users u ORDER BY u.created_at, u.id`);
    res.json(rows.map(present));
}));
usersRouter.post("/users", requireAdmin, asyncHandler(async (req, res) => {
    const { name, email, password, role } = req.body ?? {};
    if (!name?.trim() || !email?.trim() || !password) {
        return res.status(400).json({ error: "Name, email and password are all required" });
    }
    if (String(password).length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    const assignedRole = role ?? "user";
    if (!ROLES.has(assignedRole)) {
        return res.status(400).json({ error: "Role must be 'admin' or 'user'" });
    }
    const { rows: existing } = await pool.query("SELECT id FROM users WHERE lower(email) = lower($1)", [email.trim()]);
    if (existing.length > 0) {
        return res.status(409).json({ error: "An account with that email already exists" });
    }
    const { rows } = await pool.query(`INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, initials`, [name.trim(), email.trim().toLowerCase(), await bcrypt.hash(String(password), 10), assignedRole]);
    res.status(201).json(present(rows[0]));
}));
usersRouter.put("/users/:id", requireAdmin, asyncHandler(async (req, res) => {
    const { name, role, password } = req.body ?? {};
    const targetId = Number(req.params.id);
    if (role !== undefined && !ROLES.has(role)) {
        return res.status(400).json({ error: "Role must be 'admin' or 'user'" });
    }
    if (password !== undefined && String(password).length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    // The superadmin grants every other role; changing it from here would be
    // unrecoverable, so it is not editable through this endpoint at all.
    const { rows: target } = await pool.query("SELECT role FROM users WHERE id = $1", [targetId]);
    if (target.length === 0)
        return res.status(404).json({ error: "User not found" });
    if (target[0].role === "superadmin" && role !== undefined && role !== "superadmin") {
        return res.status(400).json({ error: "The super administrator's role cannot be changed." });
    }
    // A system with no administrator can never create one again, so the last
    // one cannot be demoted out of existence.
    if (role === "user") {
        const { rows: admins } = await pool.query("SELECT id FROM users WHERE role IN ('admin', 'superadmin')");
        if (admins.length === 1 && admins[0].id === targetId) {
            return res.status(400).json({ error: "This is the only administrator — promote someone else first." });
        }
    }
    const { rows } = await pool.query(`UPDATE users
       SET name = COALESCE($1, name),
           role = COALESCE($2, role),
           password_hash = COALESCE($3, password_hash)
       WHERE id = $4
       RETURNING id, name, email, role, initials`, [
        name?.trim() ?? null,
        role ?? null,
        password ? await bcrypt.hash(String(password), 10) : null,
        targetId,
    ]);
    if (rows.length === 0)
        return res.status(404).json({ error: "User not found" });
    res.json(present(rows[0]));
}));
usersRouter.delete("/users/:id", requireAdmin, asyncHandler(async (req, res) => {
    const targetId = Number(req.params.id);
    if (targetId === req.session.userId) {
        return res.status(400).json({ error: "You cannot delete your own account" });
    }
    const { rows: targetRole } = await pool.query("SELECT role FROM users WHERE id = $1", [targetId]);
    if (targetRole[0]?.role === "superadmin") {
        return res.status(400).json({ error: "The super administrator's account cannot be deleted." });
    }
    const { rows: admins } = await pool.query("SELECT id FROM users WHERE role IN ('admin', 'superadmin')");
    if (admins.length === 1 && admins[0].id === targetId) {
        return res.status(400).json({ error: "This is the only administrator — promote someone else first." });
    }
    // Quotations reference their preparer, and deleting the account would
    // orphan or destroy them. Nothing is removed if any exist.
    const { rows: work } = await pool.query("SELECT COUNT(*)::int AS n FROM quotations WHERE prepared_by = $1", [
        targetId,
    ]);
    if (work[0].n > 0) {
        return res.status(400).json({
            error: `This account has prepared ${work[0].n} quotation(s) and cannot be deleted. Change its role to 'user' instead.`,
        });
    }
    const { rows } = await pool.query("DELETE FROM users WHERE id = $1 RETURNING id", [targetId]);
    if (rows.length === 0)
        return res.status(404).json({ error: "User not found" });
    res.json({ ok: true });
}));
