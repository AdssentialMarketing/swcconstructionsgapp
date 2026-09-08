import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { SharedStrings, SheetPatcher } from "./xlsxSheetPatcher.js";
import { makeDescriptionWrapper } from "./textMetrics.js";
import { insertRowsIntoSheet, setRowBreaks } from "./xlsxRowInsert.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.join(process.cwd(), "exports");
mkdirSync(EXPORT_DIR, { recursive: true });
// A verbatim copy of the company's own invoice (SWC2026112). Produced the
// same way the quotation is: the workbook is copied through unchanged and
// only the cells that vary are rewritten, so column widths, margins, the
// letterhead in the page header and the printer settings all survive
// untouched. See xlsxSheetPatcher.ts for why nothing goes through ExcelJS.
const TEMPLATE_PATH = path.resolve(__dirname, "../../assets/invoice-template.xlsx");
const SHEET_XML = "xl/worksheets/sheet1.xml";
const SHARED_STRINGS_XML = "xl/sharedStrings.xml";
const WORKBOOK_XML = "xl/workbook.xml";
// Cell map, read out of the template.
const CELL = {
    date: "J5", // label "Date" in I5
    invoiceNo: "J6", // label "Invoice No." in I6
    terms: "J7", // label "Terms" in I7
    // "BILL TO:" sits in A9; these are the three lines beneath it.
    billTo1: "A10",
    billTo2: "A11",
    billTo3: "A12",
    attnName: "B13",
    attnPhone: "C13",
    warranty: "B51", // merged B51:G52
    totalFormula: "J53", // =SUM(J21:J52)
    downpaymentLabel: "H54",
    downpayment: "J54",
    others: "J55",
    balanceFormula: "J56", // =+J53-J54+J55
    paidMarker: "I56",
    paymentNote: "C56",
};
// Row 20 is the header (S/N | Description | QTY | Unit Price | Amount).
// Items run from 21; row 50 is left blank and rows 51-52 hold the warranty,
// so the table stops at 49.
const ITEMS_FIRST_ROW = 21;
const ITEMS_LAST_ROW = 49;
/** A plain bordered item row, cloned when the table has to grow. */
const ITEM_TEMPLATE_ROW = 45;
/** The blank row below the table, cloned for the spacers on a second page. */
const SPACER_TEMPLATE_ROW = 50;
// The template is exactly one A4 page: rows 1-62 come to 745.5pt against a
// printable 745.6pt. The last content is the balance on row 56, leaving rows
// 57-62 as padding — so up to six extra rows can be inserted and everything
// still fits on one sheet.
const SINGLE_PAGE_EXTRA_ROWS = 6;
// Past that the table runs onto a second page. Rows 1-49 leave 156pt spare,
// which is another thirteen 12pt rows before page one is genuinely full.
const PAGE_ONE_EXTRA_ROWS = 13;
// The letterhead is a header graphic that prints on every page and hangs
// 8.5pt below the top margin, so a second page opens with blank rows for the
// same reason the quotation's does.
const SPACER_ROWS = 2;
const MAX_EXTRA_ROWS = 120;
/**
 * Works out which rows the invoice's description lines go on.
 *
 * Within the template's own capacity nothing is inserted and the workbook is
 * left exactly as it ships. A little beyond it, rows are added into the
 * padding at the foot of the page. Further still, the table continues onto a
 * second page that opens with spacer rows to clear the letterhead.
 */
function planTable(neededLines) {
    const usableRows = [];
    for (let row = ITEMS_FIRST_ROW; row <= ITEMS_LAST_ROW; row++)
        usableRows.push(row);
    if (neededLines <= usableRows.length) {
        return { usableRows, templateRows: [], breakAfterRows: [], extraRows: 0 };
    }
    const overflow = neededLines - usableRows.length;
    const templateRows = [];
    const breakAfterRows = [];
    if (overflow <= SINGLE_PAGE_EXTRA_ROWS) {
        // Still one page: the added rows come out of the padding below the totals.
        for (let i = 0; i < overflow; i++) {
            templateRows.push(ITEM_TEMPLATE_ROW);
            usableRows.push(ITEMS_LAST_ROW + 1 + i);
        }
        return { usableRows, templateRows, breakAfterRows, extraRows: overflow };
    }
    const onPageOne = Math.min(overflow, PAGE_ONE_EXTRA_ROWS);
    let row = ITEMS_LAST_ROW;
    for (let i = 0; i < onPageOne; i++) {
        templateRows.push(ITEM_TEMPLATE_ROW);
        usableRows.push(++row);
    }
    breakAfterRows.push(row);
    for (let i = 0; i < SPACER_ROWS; i++) {
        templateRows.push(SPACER_TEMPLATE_ROW);
        row++;
    }
    for (let i = onPageOne; i < overflow; i++) {
        templateRows.push(ITEM_TEMPLATE_ROW);
        usableRows.push(++row);
    }
    return { usableRows, templateRows, breakAfterRows, extraRows: templateRows.length };
}
// Descriptions sit in column B and run across to G, where the QTY column
// stops them: 467px at Calibri 9. The widest line in either sample invoice
// is 425.8px, so 430 leaves the same margin the quotation template uses and
// stays well clear of where Excel starts clipping.
const MAX_LINE_PX = 430;
const wrapDescription = makeDescriptionWrapper(MAX_LINE_PX, 9);
// Every line on these invoices is a lump sum, in both the QTY and the Unit
// Price column — that is how the company fills them in.
const UNIT = "LS";
/**
 * One slot per worksheet row, including the blank row between items and the
 * "Note:" block that follows the last of them.
 */
function layOutInvoice(data) {
    const slots = [];
    data.lineItems.forEach((item, index) => {
        if (index > 0)
            slots.push({ item: null, index, line: "" });
        for (const [lineIndex, line] of wrapDescription(item.description).entries()) {
            slots.push({ item: lineIndex === 0 ? item : null, index, line });
        }
    });
    const notes = data.notes?.trim();
    if (notes) {
        // Set off from the priced work by a blank row, and headed "Note:" the way
        // the samples do. Carries no S/N and no amount — it is not billable work.
        slots.push({ item: null, index: -1, line: "" });
        slots.push({ item: null, index: -1, line: "Note:" });
        for (const line of wrapDescription(notes)) {
            slots.push({ item: null, index: -1, line });
        }
    }
    return slots;
}
export function invoiceBalance(data) {
    return +(data.total - data.downpayment + data.others).toFixed(2);
}
export async function exportInvoiceExcel(data) {
    const zip = await JSZip.loadAsync(readFileSync(TEMPLATE_PATH));
    const sheetXml = await zip.file(SHEET_XML)?.async("string");
    const sharedStringsXml = await zip.file(SHARED_STRINGS_XML)?.async("string");
    if (!sheetXml || !sharedStringsXml) {
        throw new Error("The invoice template is missing its worksheet or shared string table.");
    }
    const slots = layOutInvoice(data);
    const table = planTable(slots.length);
    const { extraRows } = table;
    if (extraRows > MAX_EXTRA_ROWS) {
        throw new Error(`This invoice needs ${slots.length} rows, which is more than an invoice is meant to run to. Shorten some descriptions or the note block.`);
    }
    // Everything the template places below the item table moves down with it.
    const belowTable = (cell) => extraRows === 0
        ? cell
        : cell.replace(/^([A-Z]+)(\d+)$/, (_full, col, row) => `${col}${Number(row) + extraRows}`);
    const strings = new SharedStrings(sharedStringsXml);
    const sheet = new SheetPatcher(extraRows === 0
        ? sheetXml
        : insertRowsIntoSheet(sheetXml, { afterRow: ITEMS_LAST_ROW, templateRows: table.templateRows }));
    // --- Header ----------------------------------------------------------
    // The labels sit in column I and the values in J, each printed with a
    // leading ": " that is part of the cell text in this template.
    sheet.setString(CELL.date, `: ${data.invoiceDate}`, strings);
    sheet.setString(CELL.invoiceNo, `: ${data.invoiceNo ?? "(unassigned)"}`, strings);
    sheet.setString(CELL.terms, `: ${data.terms}`, strings);
    for (const [index, cell] of [CELL.billTo1, CELL.billTo2, CELL.billTo3].entries()) {
        const line = data.billTo[index];
        if (line)
            sheet.setString(cell, line, strings);
        else
            sheet.clear(cell);
    }
    if (data.contactName)
        sheet.setString(CELL.attnName, data.contactName, strings);
    else
        sheet.clear(CELL.attnName);
    // The template carries the sample customer's phone number beside the name.
    // Nothing writes to it yet, so without this every invoice would print a
    // stranger's number.
    sheet.clear(CELL.attnPhone);
    // --- Item table ------------------------------------------------------
    // Slots map onto the usable rows in order; spacer rows are not in that
    // list, so they stay the blank rows they were cloned from.
    for (const [slotIndex, row] of table.usableRows.entries()) {
        const entry = slots[slotIndex];
        if (!entry) {
            sheet.clear(`A${row}`);
            sheet.clear(`B${row}`);
            sheet.clear(`H${row}`);
            sheet.clear(`I${row}`);
            sheet.clear(`J${row}`);
            continue;
        }
        if (entry.line === "")
            sheet.clear(`B${row}`);
        else
            sheet.setString(`B${row}`, entry.line, strings);
        if (entry.item) {
            sheet.setNumber(`A${row}`, entry.index + 1);
            sheet.setString(`H${row}`, UNIT, strings);
            sheet.setString(`I${row}`, UNIT, strings);
            // A nil line prints INCL, as on the quotation — work carried by the
            // job rather than billed separately. SUM() skips text, so the total is
            // unaffected.
            if (entry.item.unit_price === 0)
                sheet.setString(`J${row}`, "INCL", strings);
            else
                sheet.setNumber(`J${row}`, entry.item.unit_price);
        }
        else {
            sheet.clear(`A${row}`);
            sheet.clear(`H${row}`);
            sheet.clear(`I${row}`);
            sheet.clear(`J${row}`);
        }
    }
    // --- Money -----------------------------------------------------------
    // Total and Balance stay live formulas, as in the template; only their
    // cached results are refreshed so readers that do not recalculate still
    // show the right figures.
    sheet.setCachedFormulaValue(belowTable(CELL.totalFormula), data.total);
    sheet.setNumber(belowTable(CELL.downpayment), data.downpayment);
    sheet.setNumber(belowTable(CELL.others), data.others);
    sheet.setCachedFormulaValue(belowTable(CELL.balanceFormula), invoiceBalance(data));
    sheet.setString(belowTable(CELL.downpaymentLabel), data.downpaymentLabel?.trim() ? `Downpayment: ${data.downpaymentLabel.trim()}` : "Downpayment:", strings);
    if (data.warrantyText?.trim()) {
        sheet.setString(belowTable(CELL.warranty), `Warranty: ${data.warrantyText.trim()}`, strings);
    }
    else {
        sheet.clear(belowTable(CELL.warranty));
    }
    // Marked paid only once it has been: an unpaid invoice shows the balance
    // owing and nothing else.
    if (data.paid)
        sheet.setString(belowTable(CELL.paidMarker), "PAID", strings);
    else
        sheet.clear(belowTable(CELL.paidMarker));
    if (data.paymentNote?.trim())
        sheet.setString(belowTable(CELL.paymentNote), data.paymentNote.trim(), strings);
    else
        sheet.clear(belowTable(CELL.paymentNote));
    const replace = (name, content) => zip.file(name, content, { createFolders: false });
    replace(SHEET_XML, setRowBreaks(sheet.toXml(), table.breakAfterRows));
    replace(SHARED_STRINGS_XML, strings.toXml());
    const workbookXml = await zip.file(WORKBOOK_XML)?.async("string");
    if (workbookXml)
        replace(WORKBOOK_XML, forceRecalculationOnOpen(workbookXml));
    const outPath = path.join(EXPORT_DIR, invoiceFileName(data));
    writeFileSync(outPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    return path.relative(process.cwd(), outPath);
}
/**
 * Named the way the company names them: "SWC2026112 - 1N Limau Garden, Kew
 * Gate.xlsx" — reference number, then the site, without the postal code.
 */
function invoiceFileName(data) {
    const site = (data.billTo[0] ?? "invoice")
        .replace(/,?\s*Singapore\s*\d{6}\s*$/i, "")
        .replace(/[\\/:*?"<>|]/g, "-")
        .trim();
    return `${data.invoiceNo ?? "INVOICE"} - ${site}.xlsx`;
}
function forceRecalculationOnOpen(workbookXml) {
    if (/<calcPr[^>]*fullCalcOnLoad="1"/.test(workbookXml))
        return workbookXml;
    return workbookXml.replace(/<calcPr([^>]*?)\/>/, (_full, attrs) => `<calcPr${attrs} fullCalcOnLoad="1"/>`);
}
