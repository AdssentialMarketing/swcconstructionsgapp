import { pool } from "../db/pool.js";
// A job owned by the test salesperson, mirroring the real Limau Garden invoice.
const i = await pool.query(`INSERT INTO inspections (created_by, site_address, postal_code, status)
  VALUES (29, '1N Limau Garden, Kew Gate', '466066', 'approved') RETURNING id`);
const items = [
    { description: "Provide all necessary protection and safety measures prior to commencement of works", quantity: 1, unit: "LS", unit_price: 200, total: 200 },
    { description: "A) Jetwash L3 balcony terrace and internal parapet wall areas to remove loose and unwanted particles and do up all necessary surface preparation\n\nB) Make good of any loose or damaged tile grout with closest matching color cementitious tile grout at L3 balcony terrace", quantity: 1, unit: "LS", unit_price: 1200, total: 1200 },
    { description: "A) Carry out high pressure polyurethane injection grouting to L3 balcony terrace internal perimeter wall and floor joint areas (under skirting - 2 sides) to stop water egress", quantity: 1, unit: "LS", unit_price: 3180, total: 3180 },
];
const q = await pool.query(`INSERT INTO quotations
  (inspection_id, line_items, currency, subtotal, tax_rate, tax_amount, total, ref_no, prepared_by, status, warranty_text)
  VALUES ($1,$2,'SGD',4580,0,0,4580,'SWC26900SL',29,'approved','NIL') RETURNING id, ref_no`, [i.rows[0].id, JSON.stringify(items)]);
console.log(JSON.stringify({ inspection: i.rows[0].id, quotation: q.rows[0].id, ref: q.rows[0].ref_no }));
await pool.end();
