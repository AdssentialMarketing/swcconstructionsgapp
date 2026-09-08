import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { insertRowsIntoSheet, setRowBreaks, shiftDrawingAnchors, shiftPrintArea, } from "./xlsxRowInsert.js";
import sharp from "sharp";
import { SharedStrings, SheetPatcher } from "./xlsxSheetPatcher.js";
import { MANDATORY_FIRST_ITEM_DESCRIPTION, moveDefaultLastItemToEnd, withMandatoryFirstItem, } from "./standardLineItems.js";
import { normaliseScheduleOfWork, normaliseWarrantyText } from "./quotationTerms.js";
import { makeDescriptionWrapper } from "./textMetrics.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.join(process.cwd(), "exports");
mkdirSync(EXPORT_DIR, { recursive: true });
// A verbatim copy of samples/SWC26020SS - 58 Jalan Khairuddin.xlsx.
//
// All six files in samples/ share one company template: byte-identical
// column widths (A 9.199 / B 9.797 / C-G 12.199 / H 9.797 / I 13.199),
// page margins, print area (A1:I95), and 39 merged ranges. So the export
// is produced by copying this workbook through unchanged and rewriting
// only the cells that vary per quotation — see xlsxSheetPatcher.ts for
// why nothing here goes through ExcelJS.
const TEMPLATE_PATH = path.resolve(__dirname, "../../assets/quotation-template.xlsx");
const CALC_CHAIN_XML = "xl/calcChain.xml";
const SHEET_XML = "xl/worksheets/sheet1.xml";
const SHARED_STRINGS_XML = "xl/sharedStrings.xml";
const WORKBOOK_XML = "xl/workbook.xml";
const DRAWING_XML = "xl/drawings/drawing1.xml";
const DRAWING_RELS = "xl/drawings/_rels/drawing1.xml.rels";
const SIGNATURE_FILE = "signature.png";
const SIGNATURE_MEDIA = `xl/media/${SIGNATURE_FILE}`;
// Cell map, read directly out of the template (see the style/merge audit in
// the commit that introduced this file).
const CELL = {
    // The three letterhead address lines. Which of them is used depends on
    // whether the quotation is addressed to a company — see writeAddressBlock.
    addressLine1: "A5",
    addressLine2: "A6",
    addressLine3: "A7",
    date: "H5", // label "Date: " lives in G5
    refNo: "H6", // label "Ref no.: " lives in G6
    attnLabel: "A8",
    attnName: "B8",
    re: "A9",
    intro: "A10",
    totalFormula: "H45", // =SUM(I12:I44), merged H45:I45, accounting format
    scheduleOfWork: "C61", // label "Schedule of work" in A61
    warranty: "C62", // label "Warranty" in A62
    preparedByName: "B72",
};
// The item table body. Row 11 is the header (S/N | Description | Unit Price
// | Amount), row 12 carries the table's top border, row 44 holds the
// "Total Amount:" label in the merged H44:I44, and row 45 is the total and
// the table's bottom edge. So line items occupy rows 12-43, with the
// description in the merged B:G of each row.
const ITEMS_FIRST_ROW = 12;
const ITEMS_LAST_ROW = 43;
/**
 * The row added item rows are cloned from — a plain mid-table item row, so
 * they arrive with the table's borders and its B:G description merge.
 */
const TABLE_TEMPLATE_ROW = 42;
/** An unbordered blank row, cloned to make the spacers at the top of a page. */
const SPACER_TEMPLATE_ROW = 46;
/** The blank row between the total and the terms — the last row of a page. */
const AFTER_TOTAL_BLANK_ROW = 46;
// Pagination is decided here rather than left to Excel, because the
// letterhead is a header GRAPHIC that prints on every page, not part of the
// sheet. It is 68pt tall anchored 0.512in down, so it reaches 36.85pt past
// the 0.945in top margin and over the start of the body. The template gets
// away with this because both its pages happen to open with blank rows —
// rows 1-4 on page one, 47-49 on page two. A table that runs to any length
// has no such luck: left to Excel, page two starts mid-table and the first
// few descriptions print underneath the logo.
//
// So every page after the first opens with spacer rows of its own, and the
// breaks are placed explicitly so those spacers always land at the top.
const PAGE_BODY_PT = 842 - (0.94488188976377963 + 1.1417322834645669) * 72; // A4 portrait, template margins
const SPACER_ROWS = 3; // 3 x 14pt = 42pt, clearing the logo's 36.85pt overhang
const SPACER_ROW_PT = 14;
const ITEM_ROW_PT = 15;
// Slack against Excel rounding differently to us. Without it a page computed
// to fit exactly could break one row early, and that row would print under
// the logo — the very thing this is here to prevent.
const PAGE_SAFETY_PT = 20;
/**
 * A ceiling on how far the table may grow. Nothing about the mechanism
 * breaks past it; it is here so a runaway description can't silently
 * produce a hundred-page quotation.
 */
const MAX_EXTRA_ROWS = 160;
/**
 * Works out which worksheet rows the description lines go on.
 *
 * Up to the template's capacity nothing is inserted at all and the sheet is
 * left exactly as it ships. Beyond it the table continues onto further
 * pages, each opening with spacer rows so its first description clears the
 * letterhead. The last of those pages also has to hold the two-row total and
 * the blank row after it, so its capacity is correspondingly smaller — the
 * break that follows lands where the template's own page break did, which
 * puts the terms and signature onto their own page exactly as before.
 */
function planTable(neededLines) {
    const firstPageRows = ITEMS_LAST_ROW - ITEMS_FIRST_ROW + 1;
    const usableRows = [];
    for (let row = ITEMS_FIRST_ROW; row <= ITEMS_LAST_ROW; row++)
        usableRows.push(row);
    if (neededLines <= firstPageRows) {
        // Even a one-page table gets the break written explicitly. Excel breaks
        // here of its own accord, but LibreOffice — which converts the PDF —
        // does not reserve height for the letterhead graphic it cannot render,
        // so it fits an extra row onto page one and starts page two a row early,
        // printing the terms underneath the logo. Stating the break makes both
        // renderers paginate identically.
        return { usableRows, templateRows: [], breakAfterRows: [AFTER_TOTAL_BLANK_ROW], extraRows: 0 };
    }
    const spacerPt = SPACER_ROWS * SPACER_ROW_PT;
    const budget = PAGE_BODY_PT - PAGE_SAFETY_PT - spacerPt;
    const perPage = Math.floor(budget / ITEM_ROW_PT);
    // The final page also carries "Total Amount:", the =SUM() row and the blank
    // row that ends the page.
    const perLastPage = Math.floor((budget - 2 * ITEM_ROW_PT - SPACER_ROW_PT) / ITEM_ROW_PT);
    const pages = [];
    let remaining = neededLines - firstPageRows;
    while (remaining > 0) {
        // A page that ends the table is smaller, because it also carries the
        // total. Leaving at least one row over keeps the page being filled here
        // from becoming the last one and overflowing: filling to `perPage` when
        // only `perLastPage` fit is what put the total past the page edge and
        // left a blank sheet behind it.
        const take = remaining <= perLastPage ? remaining : Math.min(perPage, remaining - 1);
        pages.push(take);
        remaining -= take;
    }
    const templateRows = [];
    const breakAfterRows = [ITEMS_LAST_ROW];
    let row = ITEMS_LAST_ROW;
    pages.forEach((items, page) => {
        for (let i = 0; i < SPACER_ROWS; i++) {
            templateRows.push(SPACER_TEMPLATE_ROW);
            row++;
        }
        for (let i = 0; i < items; i++) {
            templateRows.push(TABLE_TEMPLATE_ROW);
            row++;
            usableRows.push(row);
        }
        // Every page but the last ends here; the last runs on into the total.
        if (page < pages.length - 1)
            breakAfterRows.push(row);
    });
    // The template's own page one ended just after the total's trailing blank
    // row, so the terms page opens on its familiar blank rows. Reproduce that.
    breakAfterRows.push(AFTER_TOTAL_BLANK_ROW + templateRows.length);
    return { usableRows, templateRows, breakAfterRows, extraRows: templateRows.length };
}
// Style ids in the template's cellXfs, used only for the RE line. The
// template (SWC26020SS) has no RE line and leaves A9/A10 at style 35;
// SWC26012SS, which does have one, uses 5 for the bold RE line and 2 for
// the intro line below it. Those two ids mean the same thing in both files
// (Calibri 10 bold / Calibri 10, both vertically top-aligned).
const STYLE_RE_LINE = "5";
const STYLE_INTRO_LINE = "2";
const STYLE_BLANK_LETTERHEAD = "35";
// "LS" (lump sum) is the only unit that appears anywhere in the sample
// quotations — all 17 line items across the six files use it — so the Unit
// Price column is normalised to it rather than printing whatever unit the
// AI draft happened to word it as ("lot", "Job").
const UNIT = "LS";
/**
 * The standing protection/safety item is enforced at export as well as at
 * drafting, so it holds even if a salesperson deletes it while editing.
 */
function buildMandatoryFirstItem() {
    return {
        description: MANDATORY_FIRST_ITEM_DESCRIPTION,
        quantity: 1,
        unit: UNIT,
        unit_price: 0,
        total: 0,
    };
}
// The samples wrap descriptions by hand, one worksheet row per visual line,
// rather than relying on wrapText. Reproducing that keeps the template's
// uniform 15pt row heights valid, since every line is guaranteed to fit on
// one line — but it means this code has to decide where to break, and
// character counts are a poor proxy in a proportional font (an all-caps
// line of 78 characters is far wider than a lowercase one).
//
// So lines are measured in pixels instead, against the real Calibri metrics
// below. The merged B:G cell is 494px wide (B 69px + five C-G columns of
// 85px each, via Excel's width formula at Calibri 11's Maximum Digit Width
// of 7), but Excel clips well before that: in a real render a 475.7px line
// was cut off mid-word and a 458.5px one sat right on the edge. The widest
// line in any of the six samples is 450.2px, so that is the budget — it is
// what the company's own quotations already print at, and it stays clear of
// the point where text starts disappearing.
const MAX_LINE_PX = 450;
// The quotation's description column is 494px of merged B:G at Calibri 11.
const wrapDescription = makeDescriptionWrapper(MAX_LINE_PX, 11);
/**
 * Fills the letterhead's three address lines.
 *
 * Addressed straight to a property, the address goes on the first line and
 * the postal code on the second. Addressed to a company, the company name
 * takes the first line and address/postal move down one. The unused third
 * line is cleared rather than left with whatever the template had.
 */
function writeAddressBlock(sheet, strings, data) {
    const postal = formatPostalCode(data.postalCode);
    const company = data.companyName?.trim();
    const lines = company ? [company, data.siteAddress, postal] : [data.siteAddress, postal, null];
    for (const [index, cell] of [CELL.addressLine1, CELL.addressLine2, CELL.addressLine3].entries()) {
        const line = lines[index];
        if (line)
            sheet.setString(cell, line, strings);
        else
            sheet.clear(cell);
    }
}
/**
 * Renders the postal code the way every sample quotation does — "Singapore
 * 457522" — while accepting either a bare code or one the salesperson
 * already typed the country onto.
 */
function formatPostalCode(postalCode) {
    const code = postalCode?.trim().replace(/^singapore\s*/i, "").trim();
    return code ? `Singapore ${code}` : null;
}
/**
 * One slot per worksheet row the items need, including the blank spacer row
 * the samples put between items. Which rows these land on is decided by
 * planTable, since that depends on how many there turn out to be.
 */
function layOutItems(lineItems) {
    const slots = [];
    lineItems.forEach((item, index) => {
        if (index > 0)
            slots.push({ item: null, index, line: "" }); // spacer between items, as in the samples
        for (const [lineIndex, line] of wrapDescription(item.description).entries()) {
            slots.push({ item: lineIndex === 0 ? item : null, index, line });
        }
    });
    return slots;
}
export async function exportQuotationExcel(data) {
    const zip = await JSZip.loadAsync(readFileSync(TEMPLATE_PATH));
    const sheetXml = await zip.file(SHEET_XML)?.async("string");
    const sharedStringsXml = await zip.file(SHARED_STRINGS_XML)?.async("string");
    if (!sheetXml || !sharedStringsXml) {
        throw new Error("The quotation template is missing its worksheet or shared string table.");
    }
    // The item table is laid out before the worksheet is touched, because how
    // many rows it needs decides whether the sheet has to grow first.
    //
    // The protection/safety item is re-applied here; the standard paintwork
    // item is only re-ordered, never re-added, since it is a drafting default
    // the salesperson may remove and adding it back would make removing it
    // impossible. Ordering is enforced here rather than left to the editor so
    // it holds however the row was edited.
    const lineItems = moveDefaultLastItemToEnd(withMandatoryFirstItem(data.lineItems, buildMandatoryFirstItem));
    const slots = layOutItems(lineItems);
    // A quotation longer than the template's one-page table extends it rather
    // than being refused: rows are inserted after the last item row, so the
    // table runs on to further pages and the total, the terms and the
    // signature block all move down with it.
    const table = planTable(slots.length);
    const { extraRows } = table;
    if (extraRows > MAX_EXTRA_ROWS) {
        throw new Error(`This quotation needs ${slots.length} rows, which is more than a quotation is meant to run to. Shorten some line item descriptions or split the job across two quotations.`);
    }
    // Everything the template places at or below the total moves down by the
    // number of rows added.
    const belowTable = (cell) => extraRows === 0
        ? cell
        : cell.replace(/^([A-Z]+)(\d+)$/, (_full, col, row) => `${col}${Number(row) + extraRows}`);
    const strings = new SharedStrings(sharedStringsXml);
    const sheet = new SheetPatcher(extraRows === 0
        ? sheetXml
        : insertRowsIntoSheet(sheetXml, { afterRow: ITEMS_LAST_ROW, templateRows: table.templateRows }));
    // --- Letterhead ------------------------------------------------------
    writeAddressBlock(sheet, strings, data);
    // The template dates the quotation with =TODAY(). That was kept as a live
    // formula, with only its cached result set to this quotation's date — but
    // the workbook also asks for a full recalculation on open, so the formula
    // fired and the date became whatever day the file was opened. On a
    // quotation valid for 30 days that is the wrong date, and in the PDF the
    // recalculated value rendered as "###" because the locale's date format
    // was wider than the column.
    //
    // Written as text instead: this is a finished document, the date on it is
    // the day the job was quoted, and it must not move afterwards.
    sheet.setString(CELL.date, formatQuotationDate(new Date(data.inspectionDate)), strings);
    sheet.setString(CELL.refNo, data.refNo ?? "(unassigned)", strings);
    if (data.contactName) {
        sheet.setString(CELL.attnLabel, "Attn: ", strings);
        sheet.setString(CELL.attnName, data.contactName, strings);
    }
    else {
        sheet.clear(CELL.attnLabel);
        sheet.clear(CELL.attnName);
    }
    sheet.setString(CELL.re, `RE: Waterproofing Works @ ${data.siteAddress}`, strings, STYLE_RE_LINE);
    sheet.setString(CELL.intro, "We are pleased to submit herewith our quotation as follows:", strings, STYLE_INTRO_LINE);
    // --- Item table ------------------------------------------------------
    // Slots map onto the usable rows in order. Spacer rows are not in that
    // list, so they are skipped here and stay the blank rows they were cloned
    // from — which is what holds the page's first description clear of the
    // letterhead.
    for (const [slotIndex, row] of table.usableRows.entries()) {
        const entry = slots[slotIndex];
        if (!entry) {
            // Unused rows keep their borders and stay visually part of the table,
            // exactly as the blank rows in the samples do.
            sheet.clear(`A${row}`);
            sheet.clear(`B${row}`);
            sheet.clear(`H${row}`);
            sheet.clear(`I${row}`);
            continue;
        }
        if (entry.line === "")
            sheet.clear(`B${row}`);
        else
            sheet.setString(`B${row}`, entry.line, strings);
        if (entry.item) {
            sheet.setNumber(`A${row}`, entry.index + 1);
            sheet.setString(`H${row}`, UNIT, strings);
            // Every line at nil prints the literal text "INCL", the way the
            // samples show work whose cost is carried by the job rather than
            // billed separately. SUM() skips text, so the total is unaffected.
            //
            // This deliberately makes no distinction between a line offered free
            // and one nobody has priced yet: they are the same value, and the
            // team's convention is that a nil line reads as included. An
            // accidentally unpriced line will therefore print as INCL, so the
            // amber highlight in the editor is the place that catches it.
            if (entry.item.unit_price === 0) {
                sheet.setString(`I${row}`, "INCL", strings);
            }
            else {
                sheet.setNumber(`I${row}`, entry.item.unit_price);
            }
        }
        else {
            sheet.clear(`A${row}`);
            sheet.clear(`H${row}`);
            sheet.clear(`I${row}`);
        }
    }
    // The total stays a live =SUM(I12:I44); only its cached result is
    // refreshed so readers that don't recalculate still show the right
    // number. data.total may include tax, which the template has no row for,
    // so the cached value is deliberately taken from the summed column to
    // stay consistent with the formula a user would see in the cell.
    const summedTotal = lineItems.reduce((sum, item) => sum + (item.unit_price || 0), 0);
    sheet.setCachedFormulaValue(belowTable(CELL.totalFormula), summedTotal);
    // --- Terms and signature block ---------------------------------------
    // Normalised again here, not just on save: these two print straight onto
    // the customer's document, so a bare "3" must never reach it however the
    // row was written.
    const scheduleOfWork = normaliseScheduleOfWork(data.scheduleOfWork);
    const warrantyText = normaliseWarrantyText(data.warrantyText);
    if (scheduleOfWork)
        sheet.setString(belowTable(CELL.scheduleOfWork), `: ${scheduleOfWork}`, strings);
    if (warrantyText)
        sheet.setString(belowTable(CELL.warranty), `: ${warrantyText}`, strings);
    // The preparer's own name and signature, or nothing if they haven't set
    // them up — in which case the template author's name and scanned
    // signature are dropped rather than left on someone else's quotation.
    // The PayNow QR stays either way: it is static company information.
    if (data.preparedByName?.trim())
        sheet.setString(belowTable(CELL.preparedByName), data.preparedByName.trim(), strings);
    else
        sheet.clear(belowTable(CELL.preparedByName));
    let signature = null;
    if (data.signaturePath) {
        signature = await prepareSignature(data.signaturePath);
    }
    // createFolders:false keeps JSZip from adding bare directory entries the
    // template doesn't have, so the package's file list stays identical too.
    const replace = (name, content) => zip.file(name, content, { createFolders: false });
    // The total's label and its figure are two rows; once the table can run to
    // any length they must not end up on either side of a page break.
    // Manual breaks, so each page's spacer rows land at its top.
    replace(SHEET_XML, setRowBreaks(sheet.toXml(), table.breakAfterRows));
    replace(SHARED_STRINGS_XML, strings.toXml());
    const drawingXml = await zip.file(DRAWING_XML)?.async("string");
    if (drawingXml) {
        if (signature) {
            replace(DRAWING_XML, placeSignatureImage(drawingXml, signature.widthPx, signature.heightPx));
            // The template's own signature occupies rId1 of the drawing; swapping
            // the file it points at reuses the anchor and relationship that Excel
            // already accepts in this workbook, instead of adding new ones.
            zip.file(SIGNATURE_MEDIA, signature.buffer, { createFolders: false });
            const drawingRels = await zip.file(DRAWING_RELS)?.async("string");
            if (drawingRels) {
                replace(DRAWING_RELS, drawingRels.replace(/(Id="rId1"[^>]*Target=")[^"]*(")/, `$1../media/${SIGNATURE_FILE}$2`));
            }
        }
        else {
            replace(DRAWING_XML, removeSignatureImage(drawingXml));
        }
        // Re-anchor whatever survived onto the rows they now sit against. This
        // runs last because placeSignatureImage tells the signature from the
        // PayNow QR by its row, which only holds at the template's numbering.
        if (extraRows > 0) {
            const placed = await zip.file(DRAWING_XML)?.async("string");
            if (placed)
                replace(DRAWING_XML, shiftDrawingAnchors(placed, ITEMS_LAST_ROW, extraRows));
        }
    }
    const workbookXml = await zip.file(WORKBOOK_XML)?.async("string");
    if (workbookXml) {
        replace(WORKBOOK_XML, forceRecalculationOnOpen(shiftPrintArea(workbookXml, ITEMS_LAST_ROW, extraRows)));
    }
    // xl/calcChain.xml lists H5 and H45 as the workbook's formula cells. Both
    // keep their formulas here, so the chain stays valid — but a chain naming
    // a cell that holds no formula is one of the things that makes Excel offer
    // to "repair" the file, so when the total moves the chain follows it.
    if (extraRows > 0) {
        const calcChain = await zip.file(CALC_CHAIN_XML)?.async("string");
        if (calcChain) {
            replace(CALC_CHAIN_XML, calcChain.replace(/<c r="([A-Z]+)(\d+)"/g, (full, col, row) => Number(row) > ITEMS_LAST_ROW ? `<c r="${col}${Number(row) + extraRows}"` : full));
        }
    }
    const outPath = path.join(EXPORT_DIR, exportFileName(data));
    writeFileSync(outPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    return path.relative(process.cwd(), outPath);
}
/**
 * Names the file the way the company's own quotations are named:
 * "SWC26020SS - 58 Jalan Khairuddin.xlsx" — ref number, then the site
 * address without its postal code.
 *
 * Falls back to the quotation id when there is no ref number yet, so an
 * export never fails or silently overwrites another quotation's file.
 */
export /**
 * The date as it prints on the quotation: 6/9/2026, day before month, which
 * is how the company's own files read.
 */ function formatQuotationDate(date) {
    return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
}
function exportFileName(data) {
    const ref = data.refNo?.trim();
    const address = data.siteAddress
        .replace(/,?\s*(?:singapore\s*)?\b\d{6}\b/gi, "") // drop a trailing postal code
        .replace(/[\\/:*?"<>|]/g, "-") // characters no filesystem should be asked to hold
        .replace(/\s+/g, " ")
        .replace(/[\s,]+$/, "")
        .trim();
    const stem = [ref || `quotation-${data.quotationId}`, address].filter(Boolean).join(" - ");
    return `${stem}.xlsx`;
}
/**
 * Removes the scanned signature from the drawing, leaving the PayNow QR.
 *
 * The template anchors the signature at rows 68-72 (the "Prepared by"
 * block) and the QR at rows 50-58, so they're told apart by anchor row.
 * The image itself and its relationship are left in the package —
 * unreferenced parts are harmless, and not touching [Content_Types].xml or
 * the rels keeps this change as small as possible.
 */
// Geometry of the signature block, measured from the template.
//
// The "SIGNATURE" caption is the merged E73:F73, so the image is centred
// across those two columns and sits in the empty rows above it. Columns E
// and F are 85px each (12.19921875 width units at Calibri 11's Maximum
// Digit Width of 7); rows 68-72 have no explicit height and so take the
// sheet's 14pt default.
const SIGNATURE_COL_INDEX = 4; // zero-based: column E
const SIGNATURE_FIRST_ROW_INDEX = 67; // zero-based: row 68
const SIGNATURE_COL_WIDTH_PX = 85;
const SIGNATURE_FIELD_WIDTH_PX = SIGNATURE_COL_WIDTH_PX * 2; // E + F
const DEFAULT_ROW_HEIGHT_PX = (14 * 96) / 72;
const SIGNATURE_ROWS = 5; // rows 68-72
const SIGNATURE_FIELD_HEIGHT_PX = DEFAULT_ROW_HEIGHT_PX * SIGNATURE_ROWS;
// Kept inside the field so the signature never touches the caption's rule.
const SIGNATURE_MAX_WIDTH_PX = 150;
const SIGNATURE_MAX_HEIGHT_PX = 80;
const EMU_PER_PX = 9525;
/**
 * Loads a signature and scales it to fit the block, preserving its shape.
 *
 * Surrounding whitespace is trimmed first: a scanned or photographed
 * signature is mostly blank paper, and without trimming the ink ends up
 * small and off-centre inside its own margins. Transparency is kept so the
 * signature sits over the caption rule rather than covering it with a
 * white box.
 */
async function prepareSignature(signaturePath) {
    try {
        const absolute = path.isAbsolute(signaturePath) ? signaturePath : path.join(process.cwd(), signaturePath);
        const trimmed = await sharp(absolute).trim().png().toBuffer();
        const meta = await sharp(trimmed).metadata();
        const width = meta.width ?? SIGNATURE_MAX_WIDTH_PX;
        const height = meta.height ?? SIGNATURE_MAX_HEIGHT_PX;
        const scale = Math.min(SIGNATURE_MAX_WIDTH_PX / width, SIGNATURE_MAX_HEIGHT_PX / height, 1);
        return {
            buffer: trimmed,
            widthPx: Math.max(1, Math.round(width * scale)),
            heightPx: Math.max(1, Math.round(height * scale)),
        };
    }
    catch {
        // Unreadable or missing signature file — export without one rather than
        // failing the whole quotation.
        return null;
    }
}
/**
 * Re-anchors the template's signature picture to centre the new image over
 * the "SIGNATURE" caption.
 *
 * The existing twoCellAnchor is edited rather than replaced: it is the
 * arrangement Excel already accepts in this workbook, so only the corner
 * offsets change.
 */
function placeSignatureImage(drawingXml, widthPx, heightPx) {
    const left = (SIGNATURE_FIELD_WIDTH_PX - widthPx) / 2;
    const top = (SIGNATURE_FIELD_HEIGHT_PX - heightPx) / 2;
    const right = left + widthPx;
    const bottom = top + heightPx;
    const at = (xPx, yPx) => ({
        col: SIGNATURE_COL_INDEX + Math.floor(xPx / SIGNATURE_COL_WIDTH_PX),
        colOff: Math.round((xPx % SIGNATURE_COL_WIDTH_PX) * EMU_PER_PX),
        row: SIGNATURE_FIRST_ROW_INDEX + Math.floor(yPx / DEFAULT_ROW_HEIGHT_PX),
        rowOff: Math.round((yPx % DEFAULT_ROW_HEIGHT_PX) * EMU_PER_PX),
    });
    const from = at(left, top);
    const to = at(right, bottom);
    const corner = (tag, p) => `<xdr:${tag}><xdr:col>${p.col}</xdr:col><xdr:colOff>${p.colOff}</xdr:colOff>` +
        `<xdr:row>${p.row}</xdr:row><xdr:rowOff>${p.rowOff}</xdr:rowOff></xdr:${tag}>`;
    return drawingXml.replace(/<xdr:twoCellAnchor[\s\S]*?<\/xdr:twoCellAnchor>/g, (anchor) => {
        const fromRow = Number(anchor.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/)?.[1] ?? -1);
        if (fromRow < 60)
            return anchor; // the PayNow QR, left alone
        return anchor
            .replace(/<xdr:from>[\s\S]*?<\/xdr:from>/, () => corner("from", from))
            .replace(/<xdr:to>[\s\S]*?<\/xdr:to>/, () => corner("to", to));
    });
}
function removeSignatureImage(drawingXml) {
    return drawingXml.replace(/<xdr:twoCellAnchor[\s\S]*?<\/xdr:twoCellAnchor>/g, (anchor) => {
        const fromRow = Number(anchor.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/)?.[1] ?? -1);
        return fromRow >= 60 ? "" : anchor;
    });
}
/**
 * Marks the workbook for a full recalculation when Excel opens it, so the
 * total formula reflects the item rows this export just rewrote.
 */
function forceRecalculationOnOpen(workbookXml) {
    if (/<calcPr[^>]*fullCalcOnLoad="1"/.test(workbookXml))
        return workbookXml;
    return workbookXml.replace(/<calcPr([^>]*?)\/>/, (_full, attrs) => `<calcPr${attrs} fullCalcOnLoad="1"/>`);
}
