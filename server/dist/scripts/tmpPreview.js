import { pool } from "../db/pool.js";
const { rows } = await pool.query(`SELECT q.id AS quotation, q.ref_no, left(i.site_address, 32) AS site,
          p.id AS photo,
          COALESCE(p.corrected_analysis, p.ai_analysis)->>'leak_type' AS leak_type,
          COALESCE(p.corrected_analysis, p.ai_analysis)->>'severity' AS severity,
          p.corrected_analysis IS NOT NULL AS corrected,
          EXISTS (SELECT 1 FROM leak_case_examples e WHERE e.source_photo_id = p.id) AS already,
          lt.name IS NOT NULL AS known_leak_type
     FROM quotations q
     JOIN inspections i ON i.id = q.inspection_id
     JOIN photos p ON p.inspection_id = i.id
     LEFT JOIN leak_types lt
       ON lt.name = COALESCE(p.corrected_analysis, p.ai_analysis)->>'leak_type'
    WHERE q.status = 'approved'
      AND q.archived_at IS NULL
      AND NOT q.excluded_from_library
      AND i.archived_at IS NULL
      AND COALESCE(p.corrected_analysis, p.ai_analysis) IS NOT NULL
    ORDER BY q.id, p.id`);
console.table(rows);
const toAdd = rows.filter((r) => !r.already);
console.log(`\n${rows.length} analysed photos on approved jobs; ${toAdd.length} not yet in the teaching set.`);
const unknown = toAdd.filter((r) => !r.known_leak_type);
if (unknown.length) {
    console.log("Off-vocabulary leak types (retrieval matches on exact name, so these would never match):");
    console.table(unknown.map((r) => ({ photo: r.photo, leak_type: r.leak_type })));
}
console.log("\nteaching set today, by leak type:");
console.table((await pool.query("SELECT leak_type, count(*) AS examples, count(*) FILTER (WHERE use_image) AS with_image FROM leak_case_examples GROUP BY leak_type ORDER BY count(*) DESC")).rows);
await pool.end();
