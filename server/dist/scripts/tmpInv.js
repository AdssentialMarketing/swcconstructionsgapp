import { exportInvoiceExcel } from "../services/invoiceExport.js";
// Rebuild SWC2026112 from its own data, to compare against the original.
console.log(await exportInvoiceExcel({
    invoiceNo: "SWC2026112",
    invoiceDate: "31/08/2026",
    terms: "Cash",
    billTo: ["1N Limau Garden, Kew Gate", "Singapore 466066", null],
    contactName: "Kelvin Tsai",
    lineItems: [
        { description: "Provide all necessary protection and safety measures prior to commencement of works", quantity: 1, unit: "LS", unit_price: 200, total: 200 },
        { description: "A) Jetwash L3 balcony terrace and internal parapet wall areas to remove loose and unwanted particles and do up all necessary surface preparation\n\nB) Make good of any loose or damaged tile grout with closest matching color cementitious tile grout at L3 balcony terrace\n\nC) Apply two coats of Clear Penetrative Waterproofing solution including applied upturns of 300mm onto walls wherever possible at L3 balcony terrace\n\nD) Apply waterproofing sealants and fiber-infused wateprroofing membrane (white - localised areas) to affected L3 balcony terrace top and internal parapet wall areas", quantity: 1, unit: "LS", unit_price: 1200, total: 1200 },
        { description: "A) Carry out high pressure polyurethane injection grouting to L3 balcony terrace internal perimeter wall and floor joint areas (under skirting - 2 sides) to stop water egress\n\nB) Make good drilled holes with closest matching color cementitious tile grout", quantity: 1, unit: "LS", unit_price: 3180, total: 3180 },
    ],
    notes: "1. General lead time for mobilisation of repair works around 2-3 weeks upon confirmation\n2. Tiled surfaces will be slightly sticky after application of clear waterproofing treatment which will gradually fade off over time for Item2C\n3. All movable items to be shifted prior to waterproofing works\n4. External façade make good plaster and paint works by others",
    warrantyText: "NIL",
    total: 4580, downpayment: 2820, downpaymentLabel: "14/8", others: 0,
    paid: false, paymentNote: null,
}));
