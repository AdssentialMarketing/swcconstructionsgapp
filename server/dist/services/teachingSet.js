import { pool } from "../db/pool.js";
/**
 * How many worked examples reach the model, and which.
 *
 * Both caps are deliberate. Example images are charged on EVERY photo
 * analysis — roughly 2,500 tokens each — so six of them is already ~15,000
 * tokens of fixed overhead before a single job photo is looked at. And
 * beyond a handful, extra examples dilute rather than sharpen: several
 * angles of one job are near-duplicates that add cost without adding
 * anything the model can discriminate on.
 *
 * Because so few get through, the ordering below is what actually decides
 * what is taught.
 */
export const CASES_PER_LEAK_TYPE = 2;
export const MAX_EXAMPLE_IMAGES = 6;
/**
 * Picks the examples to show the model.
 *
 * The leak type isn't known until after the analysis, so these can't be
 * retrieved by relevance the way pricing references are. Instead the set
 * spreads across the vocabulary — a few per type — so the model sees what
 * each type looks like rather than many instances of one.
 *
 * Within a type the order is: pinned first (someone chose this case to
 * represent the type), then human-verified (its wording is the team's, not
 * the model's own earlier output fed back to it), then most recent.
 */
export async function selectTeachingSet() {
    const { rows } = await pool.query(`SELECT id, image_path, leak_type, severity, cause, location_notes, repair_approach, notes,
            use_image, is_pinned, is_verified
     FROM (
       SELECT *, ROW_NUMBER() OVER (
                   PARTITION BY leak_type
                   ORDER BY is_pinned DESC, is_verified DESC, created_at DESC
                 ) AS rank
       FROM leak_case_examples
       WHERE is_active
     ) ranked
     WHERE rank <= $1
     ORDER BY leak_type, is_pinned DESC, is_verified DESC, created_at DESC`, [CASES_PER_LEAK_TYPE]);
    const imageIds = new Set(rows
        .filter((row) => row.use_image)
        .slice(0, MAX_EXAMPLE_IMAGES)
        .map((row) => row.id));
    return { chosen: rows, imageIds };
}
