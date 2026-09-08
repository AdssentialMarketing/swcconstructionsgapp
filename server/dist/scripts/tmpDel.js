import { pool } from "../db/pool.js";
await pool.query("DELETE FROM invoices");
await pool.query("UPDATE quotations SET ready_to_invoice_at = NULL, ready_to_invoice_by = NULL WHERE id = 43");
console.log("reset");
await pool.end();
