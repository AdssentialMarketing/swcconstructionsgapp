import { pool } from "../db/pool.js";
console.log("library rows written:");
console.table((await pool.query(`SELECT leak_type, site_type, repair_method FROM quotation_library
    WHERE quotation_id IN (SELECT id FROM quotations WHERE inspection_id = 33)`)).rows);
console.log("teaching examples written:");
console.table((await pool.query(`SELECT leak_type, chosen_method, is_verified, use_image FROM leak_case_examples
    WHERE source_photo_id IN (SELECT id FROM photos WHERE inspection_id = 33)`)).rows);
await pool.end();
