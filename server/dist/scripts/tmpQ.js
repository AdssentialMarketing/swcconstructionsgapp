import { pool } from "../db/pool.js";
console.table((await pool.query(`SELECT q.id, q.ref_no, q.status, q.inspection_id, left(i.site_address,28) AS site,
          q.archived_at IS NOT NULL AS archived, q.total, q.created_at
     FROM quotations q JOIN inspections i ON i.id = q.inspection_id
    ORDER BY q.id`)).rows);
await pool.end();
