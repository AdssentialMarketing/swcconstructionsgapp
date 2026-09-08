import { pool } from "../db/pool.js";
import { exportQuotationExcel } from "../services/excelExport.js";
// Regression: the quotation's own extension must still work after the change.
const AREAS = Array.from({ length: 8 }, (_, i) => `Area ${i + 1}`);
const items = AREAS.flatMap((a, i) => [
    { description: `${a}: Hack off existing floor and wall tiles, remove all debris, and apply two coats of cementitious waterproofing membrane to the full floor area and up the wall skirting to a height of 300mm`, quantity: 1, unit: "LS", unit_price: 850 + i * 40, total: 850 + i * 40 },
]);
const out = await exportQuotationExcel({
    quotationId: 1, refNo: "REGRESS", companyName: null, siteAddress: "regression", postalCode: "123456",
    contactName: null, preparedByName: "Stanley Seow", signaturePath: null,
    inspectionDate: new Date().toISOString(), lineItems: items, currency: "SGD",
    subtotal: 0, taxRate: 0, taxAmount: 0, total: 0, scheduleOfWork: "5 days", warrantyText: "12 months"
});
const openpyxl = out;
console.log(out);
await pool.end();
