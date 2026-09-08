import path from "node:path";
import { unlink } from "node:fs/promises";
import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAccounts } from "../middleware/requireAdmin.js";
import { exportInvoiceExcel, invoiceBalance } from "../services/invoiceExport.js";
import { getNextInvoiceNo } from "../services/invoiceNumber.js";
import { ConverterMissingError, convertXlsxToPdf } from "../services/pdfExport.js";
import { recordAudit } from "../services/audit.js";
export const invoicesRouter = Router();
/**
 * Invoicing, for the accounts team.
 *
 * Every route here is behind requireAccounts. Sales never reach them, and
 * these routes never expose the sales workspace: no photographs, no
 * assessments, no pricing library. The only thing that crosses between the
 * two is a salesperson flagging a job as ready to bill.
 */
/**
 * Jobs sales have marked ready to bill and that nobody has invoiced yet.
 *
 * Deliberately not "every approved quotation": accounts should see what has
 * actually been handed over, not everything that has ever been quoted.
 */
invoicesRouter.get("/invoicing/queue", requireAccounts, asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`SELECT q.id AS quotation_id, q.ref_no, q.total, q.ready_to_invoice_at,
              i.company_name, i.site_address, i.postal_code, i.contact_name,
              u.name AS quoted_by,
              f.name AS flagged_by
         FROM quotations q
         JOIN inspections i ON i.id = q.inspection_id
         LEFT JOIN users u ON u.id = COALESCE(q.prepared_by, i.created_by)
         LEFT JOIN users f ON f.id = q.ready_to_invoice_by
        WHERE q.ready_to_invoice_at IS NOT NULL
          AND q.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM invoices v WHERE v.quotation_id = q.id)
        ORDER BY q.ready_to_invoice_at`);
    res.json(rows);
}));
invoicesRouter.get("/invoices", requireAccounts, asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const { rows } = await pool.query(`SELECT v.*, (v.total - v.downpayment + v.others) AS balance, u.name AS created_by_name
         FROM invoices v
         LEFT JOIN users u ON u.id = v.created_by
        WHERE $1::text IS NULL OR v.status = $1
        ORDER BY v.created_at DESC`, [status]);
    res.json(rows);
}));
invoicesRouter.get("/invoices/:id", requireAccounts, asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`SELECT v.*, (v.total - v.downpayment + v.others) AS balance, u.name AS created_by_name
         FROM invoices v LEFT JOIN users u ON u.id = v.created_by WHERE v.id = $1`, [req.params.id]);
    if (rows.length === 0)
        return res.status(404).json({ error: "Invoice not found" });
    res.json(rows[0]);
}));
/**
 * Starts an invoice from a quotation.
 *
 * The figures are copied ACROSS rather than referenced: an invoice records
 * what was billed, and must not change if the quotation is edited later. The
 * result is a draft — accounts still have to add the deposit and issue it.
 */
invoicesRouter.post("/invoices", requireAccounts, asyncHandler(async (req, res) => {
    const { quotation_id } = req.body ?? {};
    if (!quotation_id)
        return res.status(400).json({ error: "quotation_id is required" });
    const { rows: source } = await pool.query(`SELECT q.id, q.inspection_id, q.line_items, q.total, q.warranty_text,
              i.company_name, i.site_address, i.postal_code, i.contact_name
         FROM quotations q JOIN inspections i ON i.id = q.inspection_id
        WHERE q.id = $1`, [quotation_id]);
    if (source.length === 0)
        return res.status(404).json({ error: "Quotation not found" });
    const q = source[0];
    const { rows: existing } = await pool.query("SELECT id FROM invoices WHERE quotation_id = $1", [
        quotation_id,
    ]);
    if (existing.length > 0) {
        return res.status(409).json({ error: "This job already has an invoice.", invoice_id: existing[0].id });
    }
    // Addressed to the company where there is one, otherwise straight to the
    // property — the same three-line shape the quotation letterhead uses.
    const postal = q.postal_code ? `Singapore ${String(q.postal_code).replace(/^singapore\s*/i, "").trim()}` : null;
    const billTo = q.company_name?.trim()
        ? [q.company_name.trim(), q.site_address, postal]
        : [q.site_address, postal, null];
    const { rows } = await pool.query(`INSERT INTO invoices
         (quotation_id, inspection_id, bill_to_line1, bill_to_line2, bill_to_line3, contact_name,
          line_items, warranty_text, total, created_by, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'quotation')
       RETURNING *`, [
        q.id,
        q.inspection_id,
        billTo[0],
        billTo[1],
        billTo[2],
        q.contact_name,
        JSON.stringify(q.line_items),
        q.warranty_text,
        Number(q.total),
        req.session.userId ?? null,
    ]);
    res.status(201).json(rows[0]);
}));
/** Edits a draft. An issued invoice is a record and does not change. */
invoicesRouter.put("/invoices/:id", requireAccounts, asyncHandler(async (req, res) => {
    const { rows: current } = await pool.query("SELECT status FROM invoices WHERE id = $1", [req.params.id]);
    if (current.length === 0)
        return res.status(404).json({ error: "Invoice not found" });
    if (current[0].status !== "draft") {
        return res.status(409).json({
            error: "This invoice has been issued. Reopen it to make changes.",
        });
    }
    const b = req.body ?? {};
    const others = Number(b.others ?? 0);
    if (!Number.isFinite(others) || others > 0) {
        // Additional work goes into the descriptions, so anything positive here
        // means the field has been misunderstood.
        return res.status(400).json({ error: "Others is for discounts, so it cannot be positive." });
    }
    const downpayment = Number(b.downpayment ?? 0);
    if (!Number.isFinite(downpayment) || downpayment < 0) {
        return res.status(400).json({ error: "Downpayment cannot be negative." });
    }
    if (b.line_items !== undefined && !Array.isArray(b.line_items)) {
        return res.status(400).json({ error: "line_items must be an array" });
    }
    const lineItems = (b.line_items ?? null);
    const total = b.total !== undefined
        ? Number(b.total)
        : lineItems
            ? lineItems.reduce((sum, item) => sum + Number(item.total || 0), 0)
            : null;
    const { rows } = await pool.query(`UPDATE invoices SET
         bill_to_line1 = COALESCE($1, bill_to_line1),
         bill_to_line2 = CASE WHEN $2::boolean THEN $3 ELSE bill_to_line2 END,
         bill_to_line3 = CASE WHEN $4::boolean THEN $5 ELSE bill_to_line3 END,
         contact_name  = CASE WHEN $6::boolean THEN $7 ELSE contact_name END,
         line_items    = COALESCE($8::jsonb, line_items),
         notes         = CASE WHEN $9::boolean THEN $10 ELSE notes END,
         warranty_text = CASE WHEN $11::boolean THEN $12 ELSE warranty_text END,
         terms         = COALESCE($13, terms),
         invoice_date  = COALESCE($14::date, invoice_date),
         total         = COALESCE($15::numeric, total),
         downpayment   = $16,
         downpayment_label = CASE WHEN $17::boolean THEN $18 ELSE downpayment_label END,
         others        = $19,
         updated_at    = now()
       WHERE id = $20
       RETURNING *, (total - downpayment + others) AS balance`, [
        b.bill_to_line1?.trim() || null,
        b.bill_to_line2 !== undefined, b.bill_to_line2?.trim() || null,
        b.bill_to_line3 !== undefined, b.bill_to_line3?.trim() || null,
        b.contact_name !== undefined, b.contact_name?.trim() || null,
        lineItems ? JSON.stringify(lineItems) : null,
        b.notes !== undefined, b.notes?.trim() || null,
        b.warranty_text !== undefined, b.warranty_text?.trim() || null,
        b.terms?.trim() || null,
        b.invoice_date || null,
        total,
        downpayment,
        b.downpayment_label !== undefined, b.downpayment_label?.trim() || null,
        others,
        req.params.id,
    ]);
    res.json(rows[0]);
}));
/**
 * Issues the invoice: claims its number and freezes it.
 *
 * The number is claimed here rather than at creation so an abandoned draft
 * does not burn one — a gap in an invoice series is the kind of thing an
 * auditor asks about.
 */
invoicesRouter.post("/invoices/:id/issue", requireAccounts, asyncHandler(async (req, res) => {
    const { rows: current } = await pool.query("SELECT status, invoice_no FROM invoices WHERE id = $1", [
        req.params.id,
    ]);
    if (current.length === 0)
        return res.status(404).json({ error: "Invoice not found" });
    if (current[0].status !== "draft") {
        return res.status(409).json({ error: "This invoice has already been issued." });
    }
    const invoiceNo = current[0].invoice_no ?? (await getNextInvoiceNo());
    const { rows } = await pool.query(`UPDATE invoices SET invoice_no = $1, status = 'issued', issued_at = now(), updated_at = now()
        WHERE id = $2 RETURNING *, (total - downpayment + others) AS balance`, [invoiceNo, req.params.id]);
    res.json(rows[0]);
}));
/**
 * Reopens an issued invoice so it can be corrected.
 *
 * Locking on issue was too strict. "Issued" here means a number has been
 * claimed, not that the document has reached the customer — and the number
 * is usually claimed several minutes before anyone looks at the result.
 * Refusing every change after that meant a typo could only be fixed with a
 * credit note, which is absurd for an invoice nobody has sent.
 *
 * The number is deliberately KEPT. Reopening does not burn a new one and
 * does not leave a hole in the series, and the reopening is written to the
 * audit trail so a document that changed after being issued can be traced.
 */
invoicesRouter.post("/invoices/:id/reopen", requireAccounts, asyncHandler(async (req, res) => {
    const { rows: current } = await pool.query("SELECT invoice_no, status FROM invoices WHERE id = $1", [req.params.id]);
    if (current.length === 0)
        return res.status(404).json({ error: "Invoice not found" });
    if (current[0].status === "draft") {
        return res.status(409).json({ error: "This invoice is already a draft." });
    }
    const { rows } = await pool.query(`UPDATE invoices SET status = 'draft', updated_at = now()
        WHERE id = $1 RETURNING *, (total - downpayment + others) AS balance`, [req.params.id]);
    await recordAudit({
        actorId: req.session.userId,
        action: "restore",
        entityType: "quotation",
        entityId: Number(req.params.id),
        entityLabel: current[0].invoice_no ?? `invoice ${req.params.id}`,
        detail: { reopened_from: current[0].status },
    });
    res.json(rows[0]);
}));
/** Records payment. The note prints beside the balance, as on the samples. */
invoicesRouter.post("/invoices/:id/paid", requireAccounts, asyncHandler(async (req, res) => {
    const { payment_note, paid } = req.body ?? {};
    const { rows } = await pool.query(`UPDATE invoices
          SET status = CASE WHEN $1::boolean THEN 'paid' ELSE 'issued' END,
              payment_note = $2,
              updated_at = now()
        WHERE id = $3 AND status <> 'draft'
        RETURNING *, (total - downpayment + others) AS balance`, [paid !== false, payment_note?.trim() || null, req.params.id]);
    if (rows.length === 0) {
        return res.status(409).json({ error: "Only an issued invoice can be marked paid." });
    }
    res.json(rows[0]);
}));
/** Rebuilds the workbook from the invoice's own stored figures. */
async function rebuildInvoiceExcel(invoiceId) {
    const { rows } = await pool.query("SELECT * FROM invoices WHERE id = $1", [invoiceId]);
    const v = rows[0];
    if (!v)
        return null;
    const excelPath = await exportInvoiceExcel({
        invoiceNo: v.invoice_no,
        invoiceDate: formatInvoiceDate(v.invoice_date),
        terms: v.terms,
        billTo: [v.bill_to_line1, v.bill_to_line2, v.bill_to_line3],
        contactName: v.contact_name,
        lineItems: v.line_items,
        notes: v.notes,
        warrantyText: v.warranty_text,
        total: Number(v.total),
        downpayment: Number(v.downpayment),
        downpaymentLabel: v.downpayment_label,
        others: Number(v.others),
        paid: v.status === "paid",
        paymentNote: v.payment_note,
    });
    if (v.excel_path && v.excel_path !== excelPath) {
        await unlink(path.join(process.cwd(), v.excel_path)).catch(() => { });
    }
    const { rows: updated } = await pool.query("UPDATE invoices SET excel_path = $1 WHERE id = $2 RETURNING *, (total - downpayment + others) AS balance", [excelPath, invoiceId]);
    return { excelPath, invoice: updated[0] };
}
/** dd/mm/yyyy with leading zeros, as the sample invoices print it. */
function formatInvoiceDate(value) {
    const d = value instanceof Date ? value : new Date(value);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
invoicesRouter.post("/invoices/:id/export", requireAccounts, asyncHandler(async (req, res) => {
    const built = await rebuildInvoiceExcel(req.params.id);
    if (!built)
        return res.status(404).json({ error: "Invoice not found" });
    res.json(built.invoice);
}));
invoicesRouter.post("/invoices/:id/export-pdf", requireAccounts, asyncHandler(async (req, res) => {
    const built = await rebuildInvoiceExcel(req.params.id);
    if (!built)
        return res.status(404).json({ error: "Invoice not found" });
    let pdfAbsolute;
    try {
        pdfAbsolute = await convertXlsxToPdf(path.join(process.cwd(), built.excelPath));
    }
    catch (err) {
        if (err instanceof ConverterMissingError)
            return res.status(503).json({ error: err.message });
        throw err;
    }
    const pdfPath = path.relative(process.cwd(), pdfAbsolute);
    if (built.invoice.pdf_path && built.invoice.pdf_path !== pdfPath) {
        await unlink(path.join(process.cwd(), built.invoice.pdf_path)).catch(() => { });
    }
    const { rows } = await pool.query("UPDATE invoices SET pdf_path = $1 WHERE id = $2 RETURNING *, (total - downpayment + others) AS balance", [pdfPath, req.params.id]);
    res.json(rows[0]);
}));
export { invoiceBalance };
