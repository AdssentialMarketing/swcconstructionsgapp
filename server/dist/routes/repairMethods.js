import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { listRepairMethods } from "../services/leakTypes.js";
export const repairMethodsRouter = Router();
/**
 * The repair method vocabulary, and which diagnoses each method suits.
 *
 * Readable by anyone signed in, because this — not the model's answer — is
 * what the photo card offers as the choice. An analysis made before methods
 * existed carries no options of its own, and a model that returns none is
 * always possible; in both cases the salesperson must still be able to
 * choose, so the vocabulary is the source of truth and the model's
 * rationales are layered on top when it has any.
 */
repairMethodsRouter.get("/repair-methods", asyncHandler(async (_req, res) => {
    const { rows: methods } = await pool.query(`SELECT id, name, description, is_invasive, suitable_when, not_suitable_when, is_active
         FROM repair_methods ORDER BY is_invasive, name`);
    res.json({ methods, mappings: await listRepairMethods() });
}));
/** Add or edit a method. Administrators only — this is company practice. */
repairMethodsRouter.put("/repair-methods", requireAdmin, asyncHandler(async (req, res) => {
    const { id, name, description, is_invasive, suitable_when, not_suitable_when, is_active } = req.body ?? {};
    if (typeof name !== "string" || name.trim() === "") {
        return res.status(400).json({ error: "A method needs a name" });
    }
    if (id) {
        // Renaming cascades to leak_type_methods and is deliberately allowed:
        // the wording of a method is the company's to correct. Rows already in
        // the library keep the old string, which is why retrieval treats a
        // method mismatch as a ranking miss rather than an error.
        await pool.query(`UPDATE repair_methods
            SET name = $1, description = $2, is_invasive = $3, suitable_when = $4,
                not_suitable_when = $5, is_active = $6
          WHERE id = $7`, [name.trim(), description ?? null, Boolean(is_invasive), suitable_when ?? null,
            not_suitable_when ?? null, is_active !== false, id]);
    }
    else {
        await pool.query(`INSERT INTO repair_methods (name, description, is_invasive, suitable_when, not_suitable_when)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (name) DO UPDATE
           SET description = EXCLUDED.description, is_invasive = EXCLUDED.is_invasive,
               suitable_when = EXCLUDED.suitable_when, not_suitable_when = EXCLUDED.not_suitable_when`, [name.trim(), description ?? null, Boolean(is_invasive), suitable_when ?? null, not_suitable_when ?? null]);
    }
    res.json({ ok: true });
}));
/** Say that a method is (or is no longer) workable for a diagnosis. */
repairMethodsRouter.put("/repair-methods/mapping", requireAdmin, asyncHandler(async (req, res) => {
    const { leak_type, method, enabled, position } = req.body ?? {};
    if (typeof leak_type !== "string" || typeof method !== "string") {
        return res.status(400).json({ error: "leak_type and method are required" });
    }
    if (enabled === false) {
        await pool.query("DELETE FROM leak_type_methods WHERE leak_type = $1 AND method = $2", [leak_type, method]);
    }
    else {
        await pool.query(`INSERT INTO leak_type_methods (leak_type, method, position) VALUES ($1, $2, $3)
         ON CONFLICT (leak_type, method) DO UPDATE SET position = EXCLUDED.position`, [leak_type, method, Number(position ?? 0)]);
    }
    res.json({ ok: true, mappings: await listRepairMethods() });
}));
