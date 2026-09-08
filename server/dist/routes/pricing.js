import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { deleteAdjustment, isPropertyType, listAdjustments, saveAdjustment, } from "../services/pricingAdjustments.js";
export const pricingRouter = Router();
/**
 * The preferential-pricing rates.
 *
 * Administrator-only to change, for the same reason excluding a job from the
 * library is: these decide what a customer is charged, and a salesperson
 * editing them would silently reprice everyone else's quotations too.
 * Readable by anyone signed in, so the editor can explain a figure.
 */
pricingRouter.get("/pricing-adjustments", asyncHandler(async (_req, res) => {
    res.json(await listAdjustments());
}));
pricingRouter.put("/pricing-adjustments", requireAdmin, asyncHandler(async (req, res) => {
    const { property_type, leak_type, adjustment_pct } = req.body ?? {};
    if (!isPropertyType(property_type)) {
        return res.status(400).json({ error: "Unknown property type" });
    }
    const pct = Number(adjustment_pct);
    if (!Number.isFinite(pct) || pct < -90 || pct > 300) {
        // A rate outside this range is a typo rather than a decision — -100%
        // would make the work free and a four-figure percentage would put an
        // absurd number in front of a customer.
        return res.status(400).json({ error: "Adjustment must be between -90% and +300%" });
    }
    const forLeakType = typeof leak_type === "string" && leak_type.trim() !== "" ? leak_type.trim() : null;
    await saveAdjustment(property_type, forLeakType, pct, req.session.userId);
    res.json(await listAdjustments());
}));
pricingRouter.delete("/pricing-adjustments/:id", requireAdmin, asyncHandler(async (req, res) => {
    const removed = await deleteAdjustment(Number(req.params.id));
    if (!removed) {
        return res.status(400).json({ error: "A property type's default rate cannot be removed, only set to 0%." });
    }
    res.json(await listAdjustments());
}));
