import { exportQuotationExcel } from "../services/excelExport.js";
const N = Number(process.env.N ?? 8);
const AREAS = Array.from({ length: N }, (_, i) => `Area ${i + 1}`);
const items = AREAS.flatMap((area, i) => [
    {
        description: `${area}: Hack off existing floor and wall tiles, remove all debris, and apply two coats of cementitious waterproofing membrane to the full floor area and up the wall skirting to a height of 300mm, including all corners and pipe penetrations`,
        quantity: 1, unit: "LS", unit_price: 850 + i * 40, total: 850 + i * 40,
    },
    {
        description: `${area}: Carry out ponding test for a minimum of 24 hours to confirm the integrity of the applied membrane`,
        quantity: 1, unit: "LS", unit_price: i % 3 === 0 ? 0 : 180, total: i % 3 === 0 ? 0 : 180,
    },
]);
const subtotal = items.reduce((s, it) => s + it.unit_price, 0);
console.log(await exportQuotationExcel({
    quotationId: 999, refNo: process.env.REF ?? "SWC26099SS", companyName: null,
    siteAddress: "936 Jurong West Street 91, #11-343", postalCode: "640936", contactName: "Mr Tan",
    preparedByName: "Stanley Seow", signaturePath: process.env.SIG ?? null,
    inspectionDate: new Date().toISOString(), lineItems: items, currency: "SGD",
    subtotal, taxRate: 0, taxAmount: 0, total: subtotal,
    scheduleOfWork: "5 working days upon confirmation",
    warrantyText: "5 years against water seepage from treated areas",
}));
