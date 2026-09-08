import { Router } from "express";
import bcrypt from "bcrypt";
import { pool } from "../db/pool.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { clearLoginFailures, loginRateLimit, recordLoginFailure } from "../middleware/loginRateLimit.js";
export const authRouter = Router();
authRouter.post("/login", loginRateLimit, asyncHandler(async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
        return res.status(400).json({ error: "email and password are required" });
    }
    const result = await pool.query("SELECT id, name, email, role, password_hash FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    if (!user) {
        recordLoginFailure(req);
        return res.status(401).json({ error: "Invalid email or password" });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
        recordLoginFailure(req);
        return res.status(401).json({ error: "Invalid email or password" });
    }
    clearLoginFailures(req);
    req.session.userId = user.id;
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
}));
authRouter.post("/logout", (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
});
authRouter.get("/me", asyncHandler(async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
    }
    const result = await pool.query("SELECT id, name, email, role FROM users WHERE id = $1", [req.session.userId]);
    const user = result.rows[0];
    if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
    }
    res.json(user);
}));
