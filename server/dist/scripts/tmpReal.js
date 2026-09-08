import { pool } from "../db/pool.js";
import { exportQuotationExcel } from "../services/excelExport.js";
const { rows } = await pool.query(`SELECT q.*, i.company_name, i.site_address, i.postal_code, i.contact_name, i.inspection_date,
          u.name AS prepared_by_name, u.signature_path AS prepared_by_signature
     FROM quotations q
     JOIN inspections i ON i.id = q.inspection_id
     LEFT JOIN users u ON u.id = COALESCE(q.prepared_by, i.created_by)
    ORDER BY q.id`);
for (const q of rows) {
    const lines = q.line_items.length;
    // Export to a throwaway ref so nothing overwrites the real files.
    const outPath = await exportQuotationExcel({
        quotationId: q.id, refNo: `VERIFY${q.id}`, companyName: q.company_name,
        siteAddress: q.site_address, postalCode: q.postal_code, contactName: q.contact_name,
        inspectionDate: new Date(q.inspection_date).toISOString().slice(0, 10),
        lineItems: q.line_items, currency: q.currency,
        subtotal: Number(q.subtotal), taxRate: Number(q.tax_rate), taxAmount: Number(q.tax_amount),
        total: Number(q.total), scheduleOfWork: q.schedule_of_work, warrantyText: q.warranty_text,
        preparedByName: q.prepared_by_name ?? null, signaturePath: q.prepared_by_signature ?? null,
    });
    console.log(`${q.ref_no} (${lines} line items) -> ${outPath}`);
}
await pool.end();
