import { pool } from "../db/pool.js";
/**
 * The company's preferential pricing, as a percentage per property type.
 *
 * This is a rule the company sets, not something the model infers. The
 * library is small enough that a rate guessed from one or two past jobs
 * would often be wrong, and a mispriced quotation goes to a customer — so
 * the model is left to decide scope and wording, which it has evidence for,
 * and the arithmetic that the office already knows is applied afterwards.
 *
 * Applied ONCE, when a quotation is drafted. Not at save and not at export:
 * those run repeatedly on the same quotation, and an adjustment applied
 * again each time would compound silently. After drafting the figures are
 * ordinary prices the salesperson can edit.
 */
export const PROPERTY_TYPES = ["hdb", "private", "commercial"];
export const PROPERTY_TYPE_LABELS = {
    hdb: "HDB",
    private: "Private property",
    commercial: "Commercial",
};
export function isPropertyType(value) {
    return typeof value === "string" && PROPERTY_TYPES.includes(value);
}
export async function listAdjustments() {
    const { rows } = await pool.query(`SELECT a.id, a.property_type, a.leak_type, a.adjustment_pct::float8 AS adjustment_pct,
            a.updated_at, u.name AS updated_by_name
       FROM pricing_adjustments a
       LEFT JOIN users u ON u.id = a.updated_by
      ORDER BY a.property_type, a.leak_type NULLS FIRST`);
    return rows;
}
/**
 * The percentage that applies to one piece of work.
 *
 * A row naming the leak type wins over the property type's default, so a
 * company can say "private property is +15%, except roof leaks which are
 * +25%" without listing every other kind of work.
 */
export async function adjustmentFor(propertyType, leakType) {
    if (!propertyType)
        return 0;
    const { rows } = await pool.query(`SELECT adjustment_pct::float8 AS adjustment_pct
       FROM pricing_adjustments
      WHERE property_type = $1 AND (leak_type = $2 OR leak_type IS NULL)
      ORDER BY leak_type NULLS LAST
      LIMIT 1`, [propertyType, leakType]);
    return rows[0]?.adjustment_pct ?? 0;
}
/**
 * Applies a percentage to a price, to the nearest dollar.
 *
 * Nil lines stay nil: they are the standing "INCL" items, and a percentage
 * of nothing that printed as $0.00 instead of INCL would be a visible
 * change to the customer's document for no reason.
 */
export function applyAdjustment(unitPrice, pct) {
    if (!unitPrice || !pct)
        return unitPrice;
    return Math.round(unitPrice * (1 + pct / 100));
}
/** Sets one rate, creating the row if this property type has none yet. */
export async function saveAdjustment(propertyType, leakType, pct, userId) {
    await pool.query(`INSERT INTO pricing_adjustments (property_type, leak_type, adjustment_pct, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (property_type, COALESCE(leak_type, ''))
     DO UPDATE SET adjustment_pct = EXCLUDED.adjustment_pct,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = now()`, [propertyType, leakType, pct, userId ?? null]);
}
/** Removes a leak-type override. The property type's default row stays. */
export async function deleteAdjustment(id) {
    const { rowCount } = await pool.query("DELETE FROM pricing_adjustments WHERE id = $1 AND leak_type IS NOT NULL", [id]);
    return (rowCount ?? 0) > 0;
}
