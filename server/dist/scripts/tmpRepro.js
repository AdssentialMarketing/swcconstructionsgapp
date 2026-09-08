import { exportQuotationExcel } from "../services/excelExport.js";
// Reproduces the shape in the screenshot: one item whose description is the
// standard paintwork sentence pasted over and over, which is what pushed the
// table onto pages 2 and 3.
const PAINT = "Make good damaged paintworks with putty compound and close matching paint colour (localized areas only)";
console.log(await exportQuotationExcel({
    quotationId: 1, refNo: "VERIFYREPRO", companyName: null,
    siteAddress: "test", postalCode: "123456", contactName: null,
    preparedByName: "Stanley Seow", signaturePath: "signatures/280a5fff-7138-41a4-949c-1e2503b57617.png",
    inspectionDate: new Date().toISOString(),
    lineItems: [{ description: PAINT.repeat(12), quantity: 1, unit: "LS", unit_price: 0, total: 0 }],
    currency: "SGD", subtotal: 0, taxRate: 0, taxAmount: 0, total: 0,
    scheduleOfWork: "15 working day(s) subjected to weather conditions",
    warrantyText: "12 (TWELVE) months from date of invoice for area(s) of work against water leakage only",
}));
