import { pool } from "../db/pool.js";
console.table((await pool.query(`SELECT q.id, q.ref_no, q.status, q.archived_at IS NOT NULL AS q_archived, q.excluded_from_library AS q_excluded,
          i.id AS insp, i.archived_at IS NOT NULL AS i_archived, i.excluded_from_library AS i_excluded,
          (SELECT count(*) FROM photos p WHERE p.inspection_id = i.id) AS photos,
          (SELECT count(*) FROM photos p WHERE p.inspection_id = i.id
             AND COALESCE(p.corrected_analysis, p.ai_analysis) IS NOT NULL) AS analysed
     FROM quotations q JOIN inspections i ON i.id = q.inspection_id ORDER BY q.id`)).rows);
await pool.end();
