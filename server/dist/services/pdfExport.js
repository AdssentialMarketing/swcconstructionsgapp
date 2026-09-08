import path from "node:path";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
const run = promisify(execFile);
/**
 * Turns an exported quotation into a PDF.
 *
 * The .xlsx is converted rather than the PDF being drawn from the quotation
 * data a second time, and that is the whole point. The workbook is a
 * byte-for-byte copy of the company's own template with only the varying
 * cells rewritten — column widths, margins, the letterhead graphic in the
 * page header, the print area, the page breaks. A second renderer would have
 * to reproduce all of that and would drift from the template the moment it
 * changed. Converting the file itself means the PDF is the quotation.
 *
 * LibreOffice does the conversion. It is the only thing that reads this
 * workbook's layout faithfully without a Microsoft licence, and it is what
 * will be installed on the server.
 */
/** Where LibreOffice tends to live, beyond whatever is on PATH. */
const CANDIDATES = [
    process.env.SOFFICE_PATH,
    "soffice",
    "libreoffice",
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
    "/opt/libreoffice/program/soffice",
    "/snap/bin/libreoffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
].filter((c) => Boolean(c));
let cachedConverter;
/**
 * Finds a usable LibreOffice, remembering the answer.
 *
 * A bare name is checked with `--version` rather than by looking at the
 * filesystem, since it may only exist on PATH.
 */
export async function findConverter() {
    if (cachedConverter !== undefined)
        return cachedConverter;
    for (const candidate of CANDIDATES) {
        try {
            if (candidate.includes(path.sep)) {
                if (!existsSync(candidate))
                    continue;
            }
            await run(candidate, ["--version"], { timeout: 20_000 });
            cachedConverter = candidate;
            return candidate;
        }
        catch {
            // Not this one.
        }
    }
    cachedConverter = null;
    return null;
}
export class ConverterMissingError extends Error {
    constructor() {
        super("PDF export needs LibreOffice on the server. Install it (Debian/Ubuntu: " +
            "`apt install libreoffice-calc fonts-crosextra-carlito`) and restart the app, " +
            "or set SOFFICE_PATH to where it lives.");
        this.name = "ConverterMissingError";
    }
}
/**
 * Converts one workbook, returning the path of the PDF written beside it.
 *
 * Each run gets its own LibreOffice profile directory. Without that, two
 * conversions at once fight over the shared default profile and one of them
 * silently produces nothing — which at three salespeople exporting at the
 * same time is not a rare case.
 */
export async function convertXlsxToPdf(xlsxAbsolutePath) {
    const converter = await findConverter();
    if (!converter)
        throw new ConverterMissingError();
    const outDir = path.dirname(xlsxAbsolutePath);
    const profile = await mkdtemp(path.join(tmpdir(), "swc-soffice-"));
    try {
        await run(converter, [
            `-env:UserInstallation=file://${profile}`,
            "--headless",
            "--norestore",
            "--convert-to",
            // The Calc filter specifically: letting LibreOffice pick can hand a
            // spreadsheet to the Writer filter and reflow the whole layout.
            "pdf:calc_pdf_Export",
            "--outdir",
            outDir,
            xlsxAbsolutePath,
        ], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    }
    finally {
        await rm(profile, { recursive: true, force: true }).catch(() => { });
    }
    // LibreOffice names the output after the input, but drops characters it
    // dislikes — unit numbers like "#11-343" are in every one of these
    // filenames — so the directory is searched rather than the name assumed.
    const expected = path.join(outDir, path.basename(xlsxAbsolutePath).replace(/\.xlsx$/i, ".pdf"));
    if (existsSync(expected)) {
        await stampHeaderFooterImages(expected, xlsxAbsolutePath);
        return expected;
    }
    const stem = path.basename(xlsxAbsolutePath).replace(/\.xlsx$/i, "");
    const produced = (await readdir(outDir))
        .filter((f) => f.toLowerCase().endsWith(".pdf"))
        .find((f) => f.startsWith(stem.slice(0, 12)));
    if (!produced) {
        throw new Error("LibreOffice ran but produced no PDF. Check the server has write access to exports/.");
    }
    const producedPath = path.join(outDir, produced);
    if (producedPath !== expected)
        await rename(producedPath, expected);
    await stampHeaderFooterImages(expected, xlsxAbsolutePath);
    return expected;
}
/**
 * Draws the letterhead and the accreditation logos back onto every page.
 *
 * The two graphics live in the workbook's page HEADER and FOOTER, as VML —
 * how Excel stores an image in a header. LibreOffice reads the header's text
 * (the address block prints correctly) but silently drops its images, so the
 * converted PDF came out with no letterhead at all. On a document that goes
 * to a customer that is not a cosmetic problem.
 *
 * Rather than reworking the template to put the logo in a cell — where it
 * would appear once instead of on every page — the images are taken from the
 * workbook that was just converted and stamped onto each page at the exact
 * position the header defines.
 */
// A4 portrait, in points.
const PAGE_HEIGHT_PT = 841.89;
const PAGE_WIDTH_PT = 595.28;
/**
 * Reads the header and footer graphics out of the workbook itself.
 *
 * Nothing is hardcoded: the sizes come from the VML shapes, the image parts
 * from that drawing's relationships, and the margins from the sheet's own
 * pageMargins. The quotation and the invoice are different templates with
 * different media filenames, different footer sizes and different margins,
 * and a future template will differ again.
 */
async function readHeaderFooter(zip) {
    const vml = await zip.file("xl/drawings/vmlDrawing1.vml")?.async("string");
    const rels = await zip.file("xl/drawings/_rels/vmlDrawing1.vml.rels")?.async("string");
    const sheet = await zip.file("xl/worksheets/sheet1.xml")?.async("string");
    if (!vml || !rels || !sheet)
        return null;
    const targets = new Map([...rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
    async function shape(id) {
        // "LH" is the left-aligned header graphic, "RF" the right-aligned footer
        // one — the ids Excel gives them for &L&G and &R&G.
        const block = vml.match(new RegExp(`<v:shape id="${id}"[\\s\\S]*?</v:shape>`));
        if (!block)
            return null;
        const width = Number(block[0].match(/width:\s*([\d.]+)pt/)?.[1] ?? 0);
        const height = Number(block[0].match(/height:\s*([\d.]+)pt/)?.[1] ?? 0);
        const relid = block[0].match(/o:relid="([^"]+)"/)?.[1];
        const target = relid ? targets.get(relid) : undefined;
        if (!target || !width || !height)
            return null;
        const part = target.replace(/^\.\.\//, "xl/");
        // uint8array, not nodebuffer: a Node Buffer smaller than 8KB is a view
        // into a shared pool at a non-zero byteOffset, and pdf-lib reads images
        // with `new DataView(bytes.buffer)` — which then starts at the wrong
        // place and rejects a perfectly valid JPEG. Whether it worked depended
        // on where the allocation happened to land.
        const bytes = await zip.file(part)?.async("uint8array");
        if (!bytes)
            return null;
        return { bytes, jpeg: /\.jpe?g$/i.test(part), widthPt: width, heightPt: height };
    }
    const m = sheet.match(/<pageMargins[^>]*\bleft="([\d.]+)"[^>]*\bright="([\d.]+)"[^>]*\bheader="([\d.]+)"[^>]*\bfooter="([\d.]+)"/);
    const margins = m
        ? {
            left: Number(m[1]) * 72,
            right: Number(m[2]) * 72,
            header: Number(m[3]) * 72,
            footer: Number(m[4]) * 72,
        }
        : { left: 36.85, right: 36.85, header: 36.85, footer: 14.17 };
    return { header: await shape("LH"), footer: await shape("RF"), margins };
}
/**
 * Draws the letterhead and the accreditation logos back onto every page.
 *
 * The two graphics live in the workbook's page HEADER and FOOTER, as VML —
 * how Excel stores an image in a header. LibreOffice reads the header's text
 * (the address block prints correctly) but silently drops its images, so a
 * converted document came out with no letterhead at all. On something that
 * goes to a customer that is not a cosmetic problem.
 */
export async function stampHeaderFooterImages(pdfPath, xlsxPath) {
    const zip = await JSZip.loadAsync(await readFile(xlsxPath));
    const found = await readHeaderFooter(zip);
    if (!found || (!found.header && !found.footer))
        return;
    const { header, footer, margins } = found;
    const pdf = await PDFDocument.load(await readFile(pdfPath));
    const embed = async (img) => img.jpeg ? pdf.embedJpg(img.bytes) : pdf.embedPng(img.bytes);
    const headerImage = header ? await embed(header) : null;
    const footerImage = footer ? await embed(footer) : null;
    for (const page of pdf.getPages()) {
        // The header sits its own margin below the top of the sheet, flush with
        // the left margin. PDF coordinates start at the bottom, hence the
        // subtraction.
        if (headerImage && header) {
            page.drawImage(headerImage, {
                x: margins.left,
                y: PAGE_HEIGHT_PT - margins.header - header.heightPt,
                width: header.widthPt,
                height: header.heightPt,
            });
        }
        // The footer graphic is right-aligned, its own margin above the bottom.
        if (footerImage && footer) {
            page.drawImage(footerImage, {
                x: PAGE_WIDTH_PT - margins.right - footer.widthPt,
                y: margins.footer,
                width: footer.widthPt,
                height: footer.heightPt,
            });
        }
    }
    await writeFile(pdfPath, await pdf.save());
}
