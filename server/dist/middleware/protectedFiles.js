import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { pool } from "../db/pool.js";
import { getRole } from "./access.js";
/**
 * Serves uploaded photos, exports and signatures with an ownership check.
 *
 * These used to go out through express.static behind requireAuth alone,
 * which only asked "are you logged in", never "is this yours". Export
 * filenames are built from the reference number and site address, so they
 * are entirely guessable — any signed-in salesperson could read another's
 * client photos and quotations by typing a path. That undoes the ownership
 * rules the API enforces everywhere else.
 *
 * Each file is resolved back to the job it belongs to and checked against
 * the same rules the API uses, with the two deliberate exceptions the UI
 * needs: an administrator reviewing a salesperson's quotation has to see its
 * photos, and the teaching set's images are administrator material.
 */
const ROOTS = {
    uploads: "uploads",
    exports: "exports",
    signatures: "signatures",
};
async function mayAccess(area, relativePath, userId) {
    const role = await getRole(userId);
    if (!role)
        return false;
    if (role === "superadmin")
        return true;
    const elevated = role === "admin";
    if (area === "signatures") {
        // Only ever your own: a signature is a personal credential, and nothing
        // in the app renders someone else's.
        const { rows } = await pool.query("SELECT 1 FROM users WHERE id = $1 AND signature_path = $2", [
            userId,
            relativePath,
        ]);
        return rows.length > 0;
    }
    if (area === "exports") {
        // Invoices live in the same directory but belong to accounts, not to the
        // salesperson who quoted the job — so they are checked by role rather
        // than by ownership, and sales cannot read them.
        const { rows: invoice } = await pool.query("SELECT 1 FROM invoices WHERE excel_path = $1 OR pdf_path = $1", [relativePath]);
        if (invoice.length > 0)
            return role === "accounts";
        // Either format of the salesperson's own quotation.
        const { rows } = await pool.query(`SELECT 1 FROM quotations q
       JOIN inspections i ON i.id = q.inspection_id
       WHERE (q.excel_path = $1 OR q.pdf_path = $1) AND i.created_by = $2`, [relativePath, userId]);
        return rows.length > 0;
    }
    // uploads: site photos, and the teaching set images promoted from them.
    const { rows: owned } = await pool.query(`SELECT 1 FROM photos p
     JOIN inspections i ON i.id = p.inspection_id
     WHERE p.file_path = $1 AND i.created_by = $2`, [relativePath, userId]);
    if (owned.length > 0)
        return true;
    if (elevated) {
        // A salesperson's photos, so an administrator can check an assessment
        // while reviewing their quotation.
        const { rows: reviewable } = await pool.query(`SELECT 1 FROM photos p
       JOIN inspections i ON i.id = p.inspection_id
       LEFT JOIN users u ON u.id = i.created_by
       WHERE p.file_path = $1 AND COALESCE(u.role, 'user') = 'user'`, [relativePath]);
        if (reviewable.length > 0)
            return true;
        // Teaching set images, which only administrators can see anyway.
        const { rows: teaching } = await pool.query("SELECT 1 FROM leak_case_examples WHERE image_path = $1", [relativePath]);
        if (teaching.length > 0)
            return true;
    }
    return false;
}
export function serveProtectedFiles(area) {
    const root = path.resolve(process.cwd(), ROOTS[area]);
    return async (req, res, next) => {
        if (!req.session.userId)
            return res.status(401).json({ error: "Not authenticated" });
        // decodeURIComponent because stored names contain "#" and spaces.
        const requested = decodeURIComponent(req.path.replace(/^\/+/, ""));
        const absolute = path.resolve(root, requested);
        // Refuse anything that escapes the directory — "../" in a URL must not
        // reach the filesystem.
        if (absolute !== root && !absolute.startsWith(root + path.sep)) {
            return res.status(400).json({ error: "Invalid path" });
        }
        if (!existsSync(absolute) || !statSync(absolute).isFile()) {
            return res.status(404).json({ error: "Not found" });
        }
        try {
            const relativePath = path.join(ROOTS[area], requested);
            if (!(await mayAccess(area, relativePath, req.session.userId))) {
                return res.status(403).json({ error: "This file belongs to another salesperson." });
            }
            // A quotation is re-exported to the SAME path every time it changes,
            // so the browser must revalidate rather than trust a cached copy —
            // otherwise an amended schedule or warranty silently downloads as the
            // previous version. "no-cache" means "ask first", not "never store":
            // res.sendFile supplies ETag and Last-Modified, so an unchanged file
            // still costs only a 304.
            res.setHeader("Cache-Control", "private, no-cache");
            if (area === "exports") {
                // The stored name is the reference number and site, which is what
                // the salesperson expects the saved file to be called.
                res.setHeader("Content-Disposition", `attachment; filename="${path.basename(absolute).replace(/"/g, "")}"`);
            }
            res.sendFile(absolute, (err) => {
                if (err && !res.headersSent)
                    next(err);
            });
        }
        catch (err) {
            next(err);
        }
    };
}
