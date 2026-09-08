import bcrypt from "bcrypt";
import { pool } from "../db/pool.js";
const hash = await bcrypt.hash("tmp-m", 10);
const u = await pool.query(`INSERT INTO users (email,name,password_hash,role,initials)
   VALUES ('tmp-m@example.invalid','Zed Zephyr',$1,'superadmin','ZZ') RETURNING id`, [hash]);
const i = await pool.query(`INSERT INTO inspections (created_by, site_address, postal_code, property_type)
   VALUES ($1,'Method test','123456','hdb') RETURNING id`, [u.rows[0].id]);
// One seepage photo (PU grouting vs hacking) and one pipe leak (hack vs bypass)
// — exactly the two cases described.
for (const [leak, sev] of [["seepage", "minor"], ["pipe leak", "moderate"]]) {
    await pool.query(`INSERT INTO photos (inspection_id, file_path, ai_analysis)
     VALUES ($1,$2,$3)`, [i.rows[0].id, `uploads/methodtest-${leak.replace(" ", "-")}.jpg`,
        JSON.stringify({ leak_type: leak, severity: sev, cause: "test", location_notes: "test",
            suggested_repair_approach: "test", confidence: 0.8 })]);
}
console.log(JSON.stringify({ user: u.rows[0].id, inspection: i.rows[0].id }));
await pool.end();
