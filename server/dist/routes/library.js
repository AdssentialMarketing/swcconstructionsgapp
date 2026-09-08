import { Router } from "express";
import { pool } from "../db/pool.js";
import { isPropertyType } from "../services/pricingAdjustments.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
export const libraryRouter = Router();
/**
 * Sets which kind of property a library entry came from.
 *
 * Rows promoted from a quotation inherit this from their inspection. The
 * imported historical ones have no inspection behind them, so this is the
 * only way to tag them — and they are the oldest and best-priced references
 * in the library, so leaving them untyped would waste them.
 */
libraryRouter.patch("/library/:id/site-type", requireAdmin, asyncHandler(async (req, res) => {
    const { site_type } = req.body ?? {};
    if (site_type !== null && !isPropertyType(site_type)) {
        return res.status(400).json({ error: "Unknown property type" });
    }
    const result = await pool.query("UPDATE quotation_library SET site_type = $1 WHERE id = $2 RETURNING *", [site_type, req.params.id]);
    if (result.rows.length === 0) {
        return res.status(404).json({ error: "Library entry not found" });
    }
    res.json(result.rows[0]);
}));
// Reading the library is administrator-only, matching the screen that shows
// it. The guard was on the write endpoints but not this one, so any signed-in
// account could fetch the whole pricing history — including the accounts team
// and any salesperson, neither of whom the Library page is offered to.
libraryRouter.get("/library", requireAdmin, asyncHandler(async (req, res) => {
    const { leak_type } = req.query;
    const result = leak_type
        ? await pool.query("SELECT * FROM quotation_library WHERE leak_type ILIKE $1 ORDER BY created_at DESC", [leak_type])
        : await pool.query("SELECT * FROM quotation_library ORDER BY created_at DESC");
    res.json(result.rows);
}));
// Flag/unflag an entry as a great phrasing example, so it's prioritized as
// a style reference for similar future cases.
libraryRouter.patch("/library/:id/style-favorite", asyncHandler(async (req, res) => {
    const { is_style_favorite } = req.body ?? {};
    const result = await pool.query("UPDATE quotation_library SET is_style_favorite = $1 WHERE id = $2 RETURNING *", [Boolean(is_style_favorite), req.params.id]);
    if (result.rows.length === 0) {
        return res.status(404).json({ error: "Library entry not found" });
    }
    res.json(result.rows[0]);
}));
libraryRouter.get("/catalog", requireAdmin, asyncHandler(async (_req, res) => {
    const result = await pool.query("SELECT * FROM line_item_catalog ORDER BY leak_type, name");
    res.json(result.rows);
}));
libraryRouter.get("/boilerplate", requireAdmin, asyncHandler(async (_req, res) => {
    const result = await pool.query("SELECT * FROM boilerplate_snippets ORDER BY category, usage_count DESC");
    res.json(result.rows);
}));
libraryRouter.patch("/boilerplate/:id", asyncHandler(async (req, res) => {
    const { is_active } = req.body ?? {};
    const result = await pool.query("UPDATE boilerplate_snippets SET is_active = $1 WHERE id = $2 RETURNING *", [Boolean(is_active), req.params.id]);
    if (result.rows.length === 0) {
        return res.status(404).json({ error: "Boilerplate snippet not found" });
    }
    res.json(result.rows[0]);
}));
