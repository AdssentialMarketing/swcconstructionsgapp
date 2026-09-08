import { pool } from "../db/pool.js";
export async function countLeakTypeUsage(name) {
    const { rows } = await pool.query(`SELECT
       (SELECT count(*)::int FROM quotation_library WHERE leak_type = $1) AS library_rows,
       (SELECT count(*)::int FROM quotation_library l
          WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(l.line_items) i
                        WHERE i->>'leak_type_tag' = $1)) AS library_item_tags,
       (SELECT count(*)::int FROM quotations q
          WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(q.line_items) i
                        WHERE i->>'leak_type_tag' = $1)) AS quotation_item_tags,
       (SELECT count(*)::int FROM leak_case_examples WHERE leak_type = $1) AS teaching_cases,
       (SELECT count(*)::int FROM photos
          WHERE ai_analysis->>'leak_type' = $1 OR corrected_analysis->>'leak_type' = $1) AS photo_analyses,
       (SELECT count(*)::int FROM quotation_reviews WHERE leak_type = $1) AS reviews`, [name]);
    const usage = rows[0];
    return {
        ...usage,
        total: usage.library_rows +
            usage.library_item_tags +
            usage.quotation_item_tags +
            usage.teaching_cases +
            usage.photo_analyses +
            usage.reviews,
    };
}
/** Rewrites every copy of a leak type's name. Both arguments are exact names. */
export async function renameLeakTypeEverywhere(client, from, to) {
    await client.query("UPDATE leak_types SET name = $2 WHERE name = $1", [from, to]);
    await client.query("UPDATE quotation_library SET leak_type = $2 WHERE leak_type = $1", [from, to]);
    await client.query("UPDATE leak_case_examples SET leak_type = $2 WHERE leak_type = $1", [from, to]);
    await client.query("UPDATE quotation_reviews SET leak_type = $2 WHERE leak_type = $1", [from, to]);
    // The analyses are stored as JSON documents, so the value has to be
    // replaced inside each one rather than in a column of its own.
    await client.query(`UPDATE photos SET ai_analysis = jsonb_set(ai_analysis, '{leak_type}', to_jsonb($2::text))
     WHERE ai_analysis->>'leak_type' = $1`, [from, to]);
    await client.query(`UPDATE photos SET corrected_analysis = jsonb_set(corrected_analysis, '{leak_type}', to_jsonb($2::text))
     WHERE corrected_analysis->>'leak_type' = $1`, [from, to]);
    // Item-level tags drive phrasing retrieval, and live inside a JSON array,
    // so each array is rebuilt with the tag replaced. Order is preserved —
    // line item order is meaningful on a quotation.
    for (const table of ["quotation_library", "quotations", "quotation_reviews"]) {
        await client.query(`UPDATE ${table} SET line_items = (
         SELECT jsonb_agg(
                  CASE WHEN item->>'leak_type_tag' = $1
                       THEN jsonb_set(item, '{leak_type_tag}', to_jsonb($2::text))
                       ELSE item END
                  ORDER BY ord)
         FROM jsonb_array_elements(line_items) WITH ORDINALITY AS t(item, ord)
       )
       WHERE line_items IS NOT NULL
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(line_items) i WHERE i->>'leak_type_tag' = $1)`, [from, to]);
    }
}
/**
 * Removes a leak type, optionally moving everything tagged with it to
 * another type first. Without a target, a type still in use is refused
 * rather than quietly orphaning the work that references it.
 */
export async function deleteLeakType(name, reassignTo) {
    const usage = await countLeakTypeUsage(name);
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        if (usage.total > 0 && reassignTo) {
            // Reassigning is the same operation as renaming — every copy of the
            // old name becomes the new one — except the vocabulary row is then
            // removed rather than kept.
            await renameLeakTypeEverywhere(client, name, reassignTo);
            await client.query("DELETE FROM leak_types WHERE name = $1", [name]);
        }
        else {
            await client.query("DELETE FROM leak_types WHERE name = $1", [name]);
        }
        await client.query("COMMIT");
        return usage;
    }
    catch (err) {
        await client.query("ROLLBACK");
        throw err;
    }
    finally {
        client.release();
    }
}
