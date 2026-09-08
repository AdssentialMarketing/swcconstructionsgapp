import { pool } from "../db/pool.js";
import { findSimilarQuotations } from "../services/retrieval.js";
// Two seepage references at different methods and very different prices —
// the situation that made averaging them wrong.
await pool.query(`INSERT INTO quotation_library (leak_type, severity, line_items, final_price, source_type, repair_method, site_type)
   VALUES ('seepage','minor','[]',900,'generated','PU grouting','hdb'),
          ('seepage','minor','[]',3800,'generated','Hack and re-waterproof','hdb')`);
const show = (label, rows) => console.log(label, rows.map((r) => `${r.repair_method ?? "untagged"}/$${Math.round(Number(r.final_price))}`).join("  "));
show("quoting PU grouting :", await findSimilarQuotations("seepage", "minor", 4, "hdb", "PU grouting"));
show("quoting hacking     :", await findSimilarQuotations("seepage", "minor", 4, "hdb", "Hack and re-waterproof"));
show("no method chosen    :", await findSimilarQuotations("seepage", "minor", 4, "hdb", null));
await pool.query("DELETE FROM quotation_library WHERE line_items::text = '[]' AND leak_type = 'seepage'");
await pool.end();
