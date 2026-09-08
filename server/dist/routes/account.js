import { Router } from "express";
import path from "node:path";
import { unlink } from "node:fs/promises";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { pool } from "../db/pool.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { initialsForUser, initialsFromName } from "../services/refNumber.js";
export const accountRouter = Router();
// Signatures live apart from site photos: they are account assets, not
// evidence, and mixing them into uploads/ would put them in front of the
// vision model when it scans for teaching examples.
const SIGNATURE_DIR = path.join(process.cwd(), "signatures");
mkdirSync(SIGNATURE_DIR, { recursive: true });
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const uploadSignature = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, SIGNATURE_DIR),
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
    }),
    fileFilter: (_req, file, cb) => {
        if (!ALLOWED.has(file.mimetype)) {
            return cb(new Error(`Unsupported file type: ${file.mimetype}. Use JPEG, PNG or WEBP.`));
        }
        cb(null, true);
    },
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});
function present(user) {
    return {
        ...user,
        // What their ref numbers will actually end with, whether or not they
        // have set an override.
        effective_initials: initialsForUser(user),
    };
}
accountRouter.get("/account", asyncHandler(async (req, res) => {
    const { rows } = await pool.query("SELECT id, name, email, initials, signature_path FROM users WHERE id = $1", [req.session.userId]);
    if (rows.length === 0)
        return res.status(404).json({ error: "User not found" });
    res.json(present(rows[0]));
}));
accountRouter.put("/account", asyncHandler(async (req, res) => {
    const { name, initials } = req.body ?? {};
    if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
        return res.status(400).json({ error: "Name cannot be empty" });
    }
    // Blank clears the override and falls back to the name; anything else
    // must be exactly two letters, since it becomes the ref number suffix.
    let initialsValue;
    if (initials !== undefined) {
        const trimmed = String(initials).trim().toUpperCase();
        if (trimmed === "")
            initialsValue = null;
        else if (/^[A-Z]{2}$/.test(trimmed))
            initialsValue = trimmed;
        else
            return res.status(400).json({ error: "Initials must be exactly two letters, e.g. SS" });
    }
    const { rows } = await pool.query(`UPDATE users
       SET name = COALESCE($1, name),
           initials = CASE WHEN $2::boolean THEN $3 ELSE initials END
       WHERE id = $4
       RETURNING id, name, email, initials, signature_path`, [name?.trim() ?? null, initialsValue !== undefined, initialsValue ?? null, req.session.userId]);
    if (rows.length === 0)
        return res.status(404).json({ error: "User not found" });
    res.json(present(rows[0]));
}));
accountRouter.post("/account/signature", uploadSignature.single("signature"), asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file)
        return res.status(400).json({ error: "No signature image uploaded" });
    const { rows: existing } = await pool.query("SELECT signature_path FROM users WHERE id = $1", [
        req.session.userId,
    ]);
    const { rows } = await pool.query(`UPDATE users SET signature_path = $1 WHERE id = $2
       RETURNING id, name, email, initials, signature_path`, [path.relative(process.cwd(), file.path), req.session.userId]);
    // Replace, don't accumulate — the previous signature has no further use.
    const previous = existing[0]?.signature_path;
    if (previous && previous !== rows[0].signature_path) {
        await unlink(path.join(process.cwd(), previous)).catch(() => { });
    }
    res.json(present(rows[0]));
}));
accountRouter.delete("/account/signature", asyncHandler(async (req, res) => {
    // Read the old path before clearing it: a subquery in RETURNING would
    // not reliably see the pre-update value.
    const { rows: existing } = await pool.query("SELECT signature_path FROM users WHERE id = $1", [
        req.session.userId,
    ]);
    const { rows } = await pool.query(`UPDATE users SET signature_path = NULL WHERE id = $1
       RETURNING id, name, email, initials, signature_path`, [req.session.userId]);
    if (rows.length === 0)
        return res.status(404).json({ error: "User not found" });
    if (existing[0]?.signature_path) {
        await unlink(path.join(process.cwd(), existing[0].signature_path)).catch(() => { });
    }
    res.json(present(rows[0]));
}));
/** Preview of the initials a given name would produce, for the account form. */
accountRouter.get("/account/initials-preview", asyncHandler(async (req, res) => {
    res.json({ initials: initialsFromName(String(req.query.name ?? "")) });
}));
