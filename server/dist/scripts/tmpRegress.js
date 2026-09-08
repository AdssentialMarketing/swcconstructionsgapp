import { pool } from "../db/pool.js";
import { exportQuotationExcel } from "../services/excelExport.js";
const q = (await pool.query(`SELECT q.*, i.company_name, i.site_address, i.postal_code, i.contact_name, i.inspection_date,
          u.name AS prepared_by_name, u.signature_path AS prepared_by_signature
     FROM quotations q JOIN inspections i ON i.id=q.inspection_id
     LEFT JOIN users u ON u.id = COALESCE(q.prepared_by, i.created_by) WHERE q.id = 23`)).rows[0];
console.log(await exportQuotationExcel({
    quotationId: q.id, refNo: q.ref_no, companyName: q.company_name, siteAddress: q.site_address,
    postalCode: q.postal_code, contactName: q.contact_name,
    inspectionDate: new Date(q.inspection_date).toISOString().slice(0, 10),
    lineItems: q.line_items, currency: q.currency, subtotal: Number(q.subtotal),
    taxRate: Number(q.tax_rate), taxAmount: Number(q.tax_amount), total: Number(q.total),
    scheduleOfWork: q.schedule_of_work, warrantyText: q.warranty_text,
    preparedByName: q.prepared_by_name, signaturePath: q.prepared_by_signature
}));
await pool.end();
