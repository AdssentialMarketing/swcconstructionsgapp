import { exportQuotationExcel } from "../services/excelExport.js";
// The 90 Sophia Road example, as it would arrive from the model: one common
// scope, two places.
const grouped = {
    description: "Remove existing damaged sealant, apply new UV-resistant waterproofing sealant to the window frame-to-wall junction to stop water ingress at:\n" +
        "a. Level 1 entrance's window frame\n" +
        "b. Level 2 meeting room's window frame and sill",
    quantity: 1, unit: "LS", unit_price: 1850, total: 1850,
};
const single = {
    description: "High pressure polyurethane injection grouting to the wall and floor joints at Level 3 daughter bedroom balcony, followed by primer and waterproofing membrane over the treated area.",
    quantity: 1, unit: "LS", unit_price: 2400, total: 2400,
};
const items = [grouped, single];
console.log(await exportQuotationExcel({
    quotationId: 1, refNo: "GROUPDEMO", companyName: null, siteAddress: "90 Sophia Road",
    postalCode: "228168", contactName: null, preparedByName: "Stanley Seow", signaturePath: null,
    inspectionDate: new Date().toISOString(), lineItems: items, currency: "SGD",
    subtotal: 4250, taxRate: 0, taxAmount: 0, total: 4250,
    scheduleOfWork: "10 working day(s) subjected to weather conditions",
    warrantyText: "12 (TWELVE) months from date of invoice for area(s) of work against water leakage only",
}));
