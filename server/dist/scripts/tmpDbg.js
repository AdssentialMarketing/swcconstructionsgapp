import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
const zip = await JSZip.loadAsync(await readFile("/tmp/original.xlsx"));
const vml = await zip.file("xl/drawings/vmlDrawing1.vml").async("string");
const rels = await zip.file("xl/drawings/_rels/vmlDrawing1.vml.rels").async("string");
const targets = new Map([...rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
for (const id of ["LH", "RF"]) {
    const block = vml.match(new RegExp(`<v:shape id="${id}"[\\s\\S]*?</v:shape>`));
    const relid = block[0].match(/o:relid="([^"]+)"/)?.[1];
    const target = relid ? targets.get(relid) : undefined;
    const part = target.replace(/^\.\.\//, "xl/");
    const isJpeg = /\.jpe?g$/i.test(part);
    const bytes = (await zip.file(part).async("nodebuffer"));
    console.log(`${id}: relid=${relid} target=${target} part=${part} treatAsJpeg=${isJpeg} magic=${bytes.subarray(0, 4).toString("hex")}`);
    const pdf = await PDFDocument.create();
    try {
        await (isJpeg ? pdf.embedJpg(bytes) : pdf.embedPng(bytes));
        console.log(`   embed OK`);
    }
    catch (e) {
        console.log(`   embed FAILED: ${e.message}`);
    }
}
