import { pool } from "../db/pool.js";
export async function listLeakTypes(activeOnly = true) {
    const { rows } = await pool.query(`SELECT id, name, description, typical_cause, typical_repair, is_active
     FROM leak_types ${activeOnly ? "WHERE is_active = true" : ""}
     ORDER BY name`);
    return rows;
}
/**
 * Picks the teaching examples to show the model.
 *
 * The leak type isn't known until after the analysis, so examples can't be
 * retrieved by relevance the way quotation references are. Instead this
 * takes a spread across the vocabulary — the most recent few per type — so
 * the model sees what each type looks like rather than many instances of
 * one. `perType` keeps the prompt bounded as the set grows.
 */
export async function findCaseExamples(perType = 2) {
    const { rows } = await pool.query(`SELECT id, image_path, leak_type, severity, cause, location_notes, repair_approach, notes, use_image
     FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY leak_type ORDER BY created_at DESC) AS rank
       FROM leak_case_examples
       WHERE is_active = true
     ) ranked
     WHERE rank <= $1
     ORDER BY leak_type, created_at DESC`, [perType]);
    return rows;
}
/**
 * Maps whatever the model answered onto the controlled vocabulary.
 *
 * Retrieval matches leak_type exactly, so an unrecognised value silently
 * costs the quotation all of its pricing references. Rather than let that
 * happen quietly, an unmappable answer is forced to "other", which the
 * salesperson then sees and corrects.
 */
export function resolveLeakType(answer, vocabulary) {
    const candidate = (answer ?? "").trim().toLowerCase();
    if (candidate === "")
        return { leakType: "other", matched: false };
    const exact = vocabulary.find((type) => type.name.toLowerCase() === candidate);
    if (exact)
        return { leakType: exact.name, matched: true };
    // Tolerate near-misses like "cracks" or "water seepage" rather than
    // discarding an otherwise-correct classification on a plural.
    const loose = vocabulary.find((type) => candidate.includes(type.name.toLowerCase()) || type.name.toLowerCase().includes(candidate));
    if (loose)
        return { leakType: loose.name, matched: true };
    return { leakType: "other", matched: false };
}
/**
 * Which repair methods are workable for each diagnosis, best-first.
 *
 * This is what lets the model offer alternatives rather than one answer.
 * Inactive methods are left out so retiring one stops it being proposed
 * without deleting the history that used it.
 */
export async function listRepairMethods() {
    const { rows } = await pool.query(`SELECT m.leak_type, m.method, r.description, r.is_invasive, r.suitable_when,
            r.not_suitable_when, m.position
       FROM leak_type_methods m
       JOIN repair_methods r ON r.name = m.method
      WHERE r.is_active
      ORDER BY m.leak_type, m.position, m.method`);
    return rows;
}
/**
 * Holds the model to the method vocabulary, the way resolveLeakType does for
 * diagnoses. An unrecognised method is dropped rather than repaired: a made-up
 * method would never match a pricing reference, and a silently renamed one
 * would quote work the company does not do.
 */
export function resolveMethods(offered, allowed, leakType) {
    const forType = allowed.filter((m) => m.leak_type === leakType);
    const byName = new Map(forType.map((m) => [m.method.toLowerCase(), m]));
    const seen = new Set();
    const resolved = [];
    for (const option of offered ?? []) {
        const match = byName.get(String(option.method ?? "").trim().toLowerCase());
        if (!match || seen.has(match.method))
            continue;
        seen.add(match.method);
        resolved.push({
            method: match.method,
            rationale: option.rationale ?? "",
            // Taken from the vocabulary, not the model: whether a method breaks up
            // finishes is a fact about the method, and the customer decides on it.
            is_invasive: match.is_invasive,
        });
    }
    // If the model offered nothing usable, fall back to every method the company
    // lists for this diagnosis. Showing the real choice with no rationale beats
    // showing none at all — the point is that the salesperson gets to choose.
    if (resolved.length === 0) {
        return forType.map((m) => ({ method: m.method, rationale: "", is_invasive: m.is_invasive }));
    }
    return resolved;
}
