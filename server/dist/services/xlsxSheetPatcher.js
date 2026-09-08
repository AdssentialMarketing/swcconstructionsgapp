// Minimal, surgical editor for a SpreadsheetML worksheet + shared string
// table.
//
// Why not just use ExcelJS: reading a workbook with ExcelJS and writing it
// back out is lossy in ways that are individually small and collectively
// ruinous for a document that has to look pixel-identical to a
// company-authored original. Measured against samples/SWC26020SS, a
// read-then-write round trip through ExcelJS:
//
//   * rewrites <cols>, dropping the template's exact column widths
//   * drops sheetFormatPr/@baseColWidth
//   * drops pageSetup/@r:id, so xl/printerSettings/printerSettings1.bin is
//     lost from the package entirely
//   * drops the <headerFooter> element, taking the letterhead/footer text
//     with it
//   * drops <legacyDrawingHF>, taking the header logo and bizSAFE badge
//     with it
//   * drops xl/calcChain.xml
//   * renumbers every style index and re-encodes every embedded image
//
// Each of those had to be detected and patched back by hand, and the ones
// that weren't yet detected were exactly the "why is the alignment still
// off" bugs. So this module takes the opposite approach: the template zip
// is copied through byte-for-byte and only the specific cell values that
// vary per quotation are rewritten in place. Styles, column widths,
// merges, borders, page setup, print area, drawings and images are never
// touched, so they cannot drift.
function xmlEscape(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
/** Excel serial date: whole days since the 1900 date system's epoch. */
export function toExcelSerialDate(date) {
    const EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
    const dayUtcMs = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.round((dayUtcMs - EPOCH_UTC_MS) / 86_400_000);
}
/**
 * Appends to xl/sharedStrings.xml, reusing an existing entry when the exact
 * text is already in the table (which is what Excel itself does).
 */
export class SharedStrings {
    xml;
    entries;
    index = new Map();
    constructor(xml) {
        this.xml = xml;
        this.entries = [...xml.matchAll(/<si>[\s\S]*?<\/si>/g)].map((m) => m[0]);
        this.entries.forEach((si, i) => {
            if (!this.index.has(si))
                this.index.set(si, i);
        });
    }
    idFor(text) {
        // xml:space="preserve" matters: descriptions and the "Attn: " label
        // carry meaningful leading/trailing spaces.
        const si = `<si><t xml:space="preserve">${xmlEscape(text)}</t></si>`;
        const existing = this.index.get(si);
        if (existing !== undefined)
            return existing;
        const id = this.entries.length;
        this.entries.push(si);
        this.index.set(si, id);
        return id;
    }
    toXml() {
        const count = this.entries.length;
        return this.xml.replace(/<sst([^>]*?)>[\s\S]*<\/sst>/, (_full, attrs) => {
            const rest = attrs.replace(/\s+count="\d+"/, "").replace(/\s+uniqueCount="\d+"/, "");
            return `<sst${rest} count="${count}" uniqueCount="${count}">${this.entries.join("")}</sst>`;
        });
    }
}
/**
 * Rewrites individual `<c>` elements in a worksheet, preserving each cell's
 * `s` (style) attribute exactly as the template had it.
 *
 * Every method requires the cell to already exist in the template. That is
 * deliberate: if the template is ever swapped for one with a different
 * layout, this throws a clear error at export time instead of silently
 * producing a misaligned document.
 */
export class SheetPatcher {
    xml;
    constructor(xml) {
        this.xml = xml;
    }
    cellRegex(ref) {
        return new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`);
    }
    locate(ref) {
        let match = this.xml.match(this.cellRegex(ref));
        if (!match) {
            // A cell with no value and no style of its own is simply absent from
            // the file — Excel writes rows sparsely. That is not a broken
            // template, so one is inserted in the right position and the write
            // goes ahead. If the ROW is missing the layout really has changed,
            // and insertCell throws.
            this.insertCell(ref);
            match = this.xml.match(this.cellRegex(ref));
        }
        if (!match) {
            throw new Error(`Cell ${ref} is missing from the template and could not be created. The workbook no longer matches the layout this exporter expects.`);
        }
        const style = match[1].match(/\ss="(\d+)"/)?.[1] ?? "";
        return { match, style };
    }
    /**
     * Adds an empty cell to an existing row, in column order.
     *
     * Cells within a row must appear left to right or Excel rejects the sheet,
     * so the insertion point is found by comparing column letters rather than
     * appending.
     */
    insertCell(ref) {
        const parsed = ref.match(/^([A-Z]+)(\d+)$/);
        if (!parsed)
            return;
        const [, column, row] = parsed;
        const rowMatch = this.xml.match(new RegExp(`<row r="${row}"[^>]*?(?:/>|>[\\s\\S]*?</row>)`));
        if (!rowMatch)
            return;
        const rank = (col) => [...col].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0);
        const target = rank(column);
        const cell = `<c r="${ref}"/>`;
        let updated;
        if (/\/>$/.test(rowMatch[0]) && !rowMatch[0].includes("</row>")) {
            // A self-closing row has no cells at all; give it a body.
            updated = rowMatch[0].replace(/\/>$/, `>${cell}</row>`);
        }
        else {
            const existing = [...rowMatch[0].matchAll(/<c r="([A-Z]+)\d+"/g)];
            const after = existing.find((m) => rank(m[1]) > target);
            updated = after
                ? rowMatch[0].slice(0, after.index) + cell + rowMatch[0].slice(after.index)
                : rowMatch[0].replace(/<\/row>$/, `${cell}</row>`);
        }
        this.xml = this.xml.replace(rowMatch[0], () => updated);
    }
    /**
     * Replaces the cell, keeping its template style unless `styleId` is given.
     *
     * The replacement is passed as a function because cell text can legally
     * contain `$` (prices, "$/m2" units), which String.replace would
     * otherwise read as a substitution pattern like `$&`.
     */
    write(ref, body, typeAttr, styleId) {
        const { match, style } = this.locate(ref);
        const s = styleId ?? style;
        const sAttr = s === "" ? "" : ` s="${s}"`;
        const replacement = `<c r="${ref}"${sAttr}${typeAttr}${body}`;
        this.xml = this.xml.replace(match[0], () => replacement);
    }
    setString(ref, text, sharedStrings, styleId) {
        this.write(ref, `><v>${sharedStrings.idFor(text)}</v></c>`, ' t="s"', styleId);
    }
    setNumber(ref, value, styleId) {
        this.write(ref, `><v>${value}</v></c>`, "", styleId);
    }
    setDate(ref, date, styleId) {
        this.setNumber(ref, toExcelSerialDate(date), styleId);
    }
    /** Empties the cell but leaves its style — i.e. borders and fills stay. */
    clear(ref, styleId) {
        const { match, style } = this.locate(ref);
        const s = styleId ?? style;
        const replacement = `<c r="${ref}"${s === "" ? "" : ` s="${s}"`}/>`;
        this.xml = this.xml.replace(match[0], () => replacement);
    }
    /**
     * Refreshes a formula cell's cached result without disturbing the formula
     * itself. Excel recalculates on open (see fullCalcOnLoad), but the cached
     * value is what every other reader shows — Quick Look, Preview's PDF
     * export, Numbers, Google Sheets — so it has to be right too.
     */
    setCachedFormulaValue(ref, value) {
        const { match } = this.locate(ref);
        const body = match[2] ?? "";
        // `<f` rather than `<f>`: a formula element carries attributes in
        // practice — the template's =TODAY() is <f ca="1">, marking it
        // calculate-always.
        if (!/<f[\s>]/.test(body)) {
            throw new Error(`Expected a formula in ${ref} of the quotation template, found none.`);
        }
        const updated = /<v>[\s\S]*?<\/v>/.test(body)
            ? body.replace(/<v>[\s\S]*?<\/v>/, () => `<v>${value}</v>`)
            : `${body}<v>${value}</v>`;
        const replacement = match[0].replace(body, () => updated);
        this.xml = this.xml.replace(match[0], () => replacement);
    }
    toXml() {
        return this.xml;
    }
}
