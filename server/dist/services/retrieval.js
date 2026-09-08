import { pool } from "../db/pool.js";
/**
 * Excludes library rows whose job has been marked "do not learn from this".
 *
 * The flag lives on the quotation (and on the inspection its photo came
 * from), not on the library row, so retrieval has to check across. Imported
 * historical rows have neither link and are never excluded by this.
 *
 * Written as NOT EXISTS rather than a join so a row is dropped once, however
 * many ways it might match.
 */
const NOT_EXCLUDED = `
  NOT EXISTS (
    SELECT 1 FROM quotations exq
    WHERE exq.id = %ALIAS%.quotation_id AND exq.excluded_from_library
  )
  AND NOT EXISTS (
    SELECT 1 FROM photos exp
    JOIN inspections exi ON exi.id = exp.inspection_id
    WHERE exp.id = %ALIAS%.photo_id AND exi.excluded_from_library
  )`;
const notExcluded = (alias) => NOT_EXCLUDED.replaceAll("%ALIAS%", alias);
/**
 * Phase 1 retrieval: match by leak_type (required) and prefer same severity.
 * Style-favorited entries and same-severity entries are ranked first.
 * Vector similarity search (pgvector) is planned for Phase 3 — see project README.
 *
 * Repair method is ranked ABOVE property type, because it is the larger
 * price difference: hacking and re-waterproofing a toilet against PU grouting
 * the same toilet is a different job, where HDB against private is the same
 * job at a different rate. Still a preference rather than a filter, for the
 * same reason.
 *
 * Property type is a PREFERENCE, not a filter, and deliberately so. The same
 * scope is priced differently for a HDB flat and a private property, so
 * like-for-like references rank first — but splitting the library in two
 * would leave most leak types with no references at all on one side of the
 * split, and retrieval finding nothing is what makes every line draft at
 * zero. A job of the other type still teaches scope, wording, schedule and
 * warranty, which barely vary; only the price does, and that is corrected
 * by the pricing adjustment rather than by hiding the evidence.
 */
export async function findSimilarQuotations(leakType, severity, limit = 5, propertyType = null, repairMethod = null) {
    const result = await pool.query(`SELECT id, leak_type, severity, region, site_type, repair_method, line_items, final_price,
            is_style_favorite, schedule_of_work, warranty_text, created_at
     FROM quotation_library
     WHERE leak_type ILIKE $1
       AND ${notExcluded("quotation_library")}
     ORDER BY
       is_style_favorite DESC,
       -- COALESCE, not a bare comparison: an untagged row compares NULL, and
       -- Postgres sorts NULLS FIRST under DESC — which floated every untagged
       -- row above the ones that actually match.
       COALESCE(repair_method = $5, false) DESC,
       COALESCE(site_type = $4, false) DESC,
       COALESCE(severity = $2, false) DESC,
       created_at DESC
     LIMIT $3`, [leakType, severity, limit, propertyType, repairMethod]);
    return result.rows;
}
/**
 * Pulls the 3-5 most similar past line items by their own leak_type_tag
 * (not the parent row's overall leak_type — one historical quotation can
 * mix leak-specific items with generic ones like PPE/protection or paint
 * touch-up, so item-level tags give a more accurate phrasing match),
 * prioritizing style-favorited entries, so their exact original wording can
 * be shown to Claude as phrasing examples.
 */
export async function findStyleReferenceLineItems(leakType, limit = 5) {
    const result = await pool.query(`SELECT item->>'description' AS description, ql.is_style_favorite
     FROM quotation_library ql, jsonb_array_elements(ql.line_items) item
     WHERE item->>'leak_type_tag' ILIKE $1
       AND ${notExcluded("ql")}
     ORDER BY ql.is_style_favorite DESC, ql.created_at DESC
     LIMIT $2`, [leakType, limit]);
    return result.rows;
}
export async function getActiveBoilerplate() {
    const result = await pool.query(`SELECT id, category, text, usage_count
     FROM boilerplate_snippets
     WHERE is_active = true
     ORDER BY usage_count DESC`);
    return result.rows;
}
/**
 * The schedule-of-work and warranty wordings most often used on past jobs of
 * a given leak type, most frequent first.
 *
 * These two lines are boilerplate apart from their duration, so the right
 * answer is nearly always "whatever we said last time for this kind of
 * job". Counting them here gives the draft a factual prior instead of
 * leaving the model to eyeball a handful of reference rows — and because
 * approving a quotation writes it into quotation_library, the counts shift
 * as the team's own practice changes.
 */
export async function findCommonTerms(leakType, limit = 3) {
    const query = async (column) => {
        const { rows } = await pool.query(`SELECT ${column} AS value, count(*)::int AS count
       FROM quotation_library
       WHERE leak_type ILIKE $1 AND ${column} IS NOT NULL AND btrim(${column}) <> ''
         AND ${notExcluded("quotation_library")}
       GROUP BY ${column}
       ORDER BY count DESC, max(created_at) DESC
       LIMIT $2`, [leakType, limit]);
        return rows;
    };
    const [schedule, warranty] = await Promise.all([query("schedule_of_work"), query("warranty_text")]);
    return { schedule, warranty };
}
/** Same, across every past job — the fallback when a leak type has no history of its own. */
export async function findCommonTermsOverall(limit = 3) {
    return findCommonTerms("%", limit);
}
