import path from "node:path";
import { convertXlsxToPdf } from "../services/pdfExport.js";
for (const f of ["exports/SWC2026112 - 1N Limau Garden, Kew Gate.xlsx", "exports/SWC26024SS - 90 Sophia Road.xlsx"]) {
    console.log(await convertXlsxToPdf(path.resolve(f)));
}
