/**
 * Extends the quotation's item table by inserting rows into the worksheet.
 *
 * The template is a fixed one-page layout: 32 item rows, then the total,
 * then the terms and the signature block. A quotation with more content than
 * that used to be refused outright. Inserting rows lets the table run onto a
 * second page, carrying the total and everything below it down with it.
 *
 * Excel stores a sheet as absolute cell addresses, so "inserting a row" means
 * rewriting every reference below the insertion point. Five things hold such
 * references and every one of them has to move together, or the file opens
 * with the total in the wrong place, merges across the wrong cells, or the
 * PayNow QR floating over the terms:
 *
 *   1. row and cell addresses in sheetData
 *   2. merged ranges
 *   3. the total's =SUM() range, which must also widen to cover the new rows
 *   4. the sheet dimension and the workbook's print area
 *   5. the anchors of the floating images
 *
 * calcChain is dropped rather than rewritten: it names H45 as a formula cell
 * and that address changes, and a chain naming a cell with no formula is one
 * of the things that makes Excel offer to repair the file.
 */
/** Shifts a single "A44" style reference down by `count` if it is at or below `from`. */
function shiftRef(ref, from, count) {
    return ref.replace(/^([A-Z]+)(\d+)$/, (_full, col, row) => {
        const n = Number(row);
        return n >= from ? `${col}${n + count}` : `${col}${n}`;
    });
}
function shiftRange(range, from, count) {
    return range
        .split(":")
        .map((ref) => shiftRef(ref, from, count))
        .join(":");
}
/** Splits sheetData into its individual `<row>` blocks, keeping their order. */
function splitRows(sheetData) {
    const rows = [];
    for (const match of sheetData.matchAll(/<row [^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) {
        const row = Number(match[0].match(/\br="(\d+)"/)?.[1] ?? 0);
        rows.push({ row, xml: match[0] });
    }
    return rows;
}
/** Rewrites one row block to sit at a different row number. */
function renumberRow(xml, oldRow, newRow) {
    return xml
        .replace(new RegExp(`(<row [^>]*?\\br=")${oldRow}(")`), `$1${newRow}$2`)
        .replace(new RegExp(`(<c r="[A-Z]+)${oldRow}(")`, "g"), `$1${newRow}$2`);
}
/** Empties every cell of a row, keeping its styles — the new rows start blank. */
function blankRow(xml) {
    return xml.replace(/<c ([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g, (_full, attrs) => {
        // Drop the type attribute along with the value: a cell left as t="s"
        // with no <v> is not valid.
        const kept = attrs.replace(/\s+t="[^"]*"/g, "").trimEnd();
        return `<c ${kept}/>`;
    });
}
export function insertRowsIntoSheet(sheetXml, insertion) {
    const { afterRow, templateRows } = insertion;
    const count = templateRows.length;
    if (count <= 0)
        return sheetXml;
    const from = afterRow + 1;
    const sheetDataMatch = sheetXml.match(/<sheetData>([\s\S]*)<\/sheetData>/);
    if (!sheetDataMatch)
        throw new Error("Worksheet has no sheetData to extend.");
    const rows = splitRows(sheetDataMatch[1]);
    const sourceFor = (templateRow) => {
        const source = rows.find((r) => r.row === templateRow);
        if (!source)
            throw new Error(`Row ${templateRow} is missing from the template; cannot extend the table.`);
        return source.xml;
    };
    // Rows above the insertion point are untouched; the new blank rows go in
    // between; everything from the insertion point down moves by `count`.
    const before = rows.filter((r) => r.row < from).map(({ xml }) => xml).join("");
    const inserted = templateRows
        .map((templateRow, i) => blankRow(renumberRow(sourceFor(templateRow), templateRow, afterRow + 1 + i)))
        .join("");
    const after = rows
        .filter((r) => r.row >= from)
        .map(({ row, xml }) => renumberRow(xml, row, row + count))
        .join("");
    let out = sheetXml.replace(/<sheetData>[\s\S]*<\/sheetData>/, () => `<sheetData>${before}${inserted}${after}</sheetData>`);
    // Merged ranges below the insertion point move. Each new row also takes on
    // whatever single-row merge its template row has — without the B:G merge an
    // item row's description would be confined to column B — while a spacer row
    // cloned from an unmerged blank row correctly gets none.
    out = out.replace(/<mergeCells[^>]*>([\s\S]*?)<\/mergeCells>/, (_full, body) => {
        const refs = [...body.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map((m) => shiftRange(m[1], from, count));
        templateRows.forEach((templateRow, i) => {
            const merge = body.match(new RegExp(`<mergeCell ref="([A-Z]+${templateRow}:[A-Z]+${templateRow})"/>`));
            if (!merge)
                return;
            const [start, end] = merge[1].split(":");
            const row = afterRow + 1 + i;
            refs.push(`${start.replace(/\d+$/, "")}${row}:${end.replace(/\d+$/, "")}${row}`);
        });
        return `<mergeCells count="${refs.length}">${refs.map((r) => `<mergeCell ref="${r}"/>`).join("")}</mergeCells>`;
    });
    // Formulas move with their rows but their references do not, so every cell
    // address inside a formula is shifted too. That covers the total widening
    // to include the new rows — SUM(J21:J52) becomes SUM(J21:J52+n) because the
    // end of the range is below the insertion point — and equally the balance
    // formula further down, which subtracts one moved cell from another.
    out = out.replace(/<f([^>]*)>([\s\S]*?)<\/f>/g, (_full, attrs, formula) => {
        const shifted = formula.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g, (ref, d1, col, d2, row) => {
            const n = Number(row);
            return n >= from ? `${d1}${col}${d2}${n + count}` : ref;
        });
        return `<f${attrs}>${shifted}</f>`;
    });
    out = out.replace(/<dimension ref="([^"]+)"\/>/, (_full, ref) => {
        return `<dimension ref="${shiftRange(ref, from, count)}"/>`;
    });
    return out;
}
/**
 * Sets the sheet's manual page breaks.
 *
 * Where the table breaks is decided here rather than left to Excel, because
 * the letterhead is a header graphic that prints on every page and overhangs
 * the top margin. Content has to start far enough down to clear it, which
 * only holds if we choose the boundaries and put spacer rows after them.
 */
export function setRowBreaks(sheetXml, breakAfterRows) {
    if (breakAfterRows.length === 0)
        return sheetXml;
    const brks = breakAfterRows.map((row) => `<brk id="${row}" max="16383" man="1"/>`).join("");
    const element = `<rowBreaks count="${breakAfterRows.length}" manualBreakCount="${breakAfterRows.length}">${brks}</rowBreaks>`;
    // rowBreaks sits between headerFooter and drawing in the schema's fixed
    // child order; anywhere else and Excel rejects the sheet.
    if (/<drawing /.test(sheetXml))
        return sheetXml.replace(/<drawing /, `${element}<drawing `);
    return sheetXml.replace(/<\/worksheet>/, `${element}</worksheet>`);
}
/** Moves floating images (PayNow QR, signature) down with the rows beneath them. */
export function shiftDrawingAnchors(drawingXml, afterRow, count) {
    if (count <= 0)
        return drawingXml;
    // Drawing anchors are zero-based, so a row number here is one less than
    // the worksheet's.
    const fromZeroBased = afterRow; // afterRow + 1 in 1-based == afterRow in 0-based
    return drawingXml.replace(/<xdr:row>(\d+)<\/xdr:row>/g, (_full, row) => {
        const n = Number(row);
        return `<xdr:row>${n >= fromZeroBased ? n + count : n}</xdr:row>`;
    });
}
/** Extends the print area so the added rows are actually printed. */
export function shiftPrintArea(workbookXml, afterRow, count) {
    if (count <= 0)
        return workbookXml;
    return workbookXml.replace(/(<definedName name="_xlnm\.Print_Area"[^>]*>)([^<]*)(<\/definedName>)/, (_full, open, value, close) => {
        const shifted = value.replace(/\$([A-Z]+)\$(\d+)/g, (ref, col, row) => {
            const n = Number(row);
            return n >= afterRow + 1 ? `$${col}$${n + count}` : ref;
        });
        return `${open}${shifted}${close}`;
    });
}
