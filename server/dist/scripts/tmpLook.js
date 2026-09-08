import { pool } from "../db/pool.js";
const rows = (await pool.query(`SELECT v.id, v.invoice_no, v.status, v.total, v.notes, v.bill_to_line1,
          jsonb_array_length(v.line_items) AS items, v.line_items
     FROM invoices v ORDER BY v.id`)).rows;
for (const v of rows) {
    console.log(`\ninvoice ${v.id} ${v.invoice_no ?? "(draft)"} — ${v.status} — ${v.bill_to_line1} — ${v.items} items`);
    for (const [i, it] of v.line_items.entries()) {
        console.log(`  ${i + 1}. ${it.description.slice(0, 90)}${it.description.length > 90 ? "…" : ""}`);
    }
    if (v.notes)
        console.log("  notes:", String(v.notes).slice(0, 120));
}
await pool.end();
