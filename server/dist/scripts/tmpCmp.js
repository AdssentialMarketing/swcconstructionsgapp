import { convertXlsxToPdf } from "../services/pdfExport.js";
console.log(await convertXlsxToPdf("/tmp/original.xlsx"));
