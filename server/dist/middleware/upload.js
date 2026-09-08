import multer from "multer";
import path from "node:path";
import { randomUUID } from "node:crypto";
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_FILES_PER_UPLOAD = 10;
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${randomUUID()}${ext}`);
    },
});
function fileFilter(_req, file, cb) {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
        return cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: JPEG, PNG, WEBP.`));
    }
    cb(null, true);
}
export const uploadPhotos = multer({
    storage,
    fileFilter,
    limits: { fileSize: MAX_FILE_SIZE_BYTES, files: MAX_FILES_PER_UPLOAD },
});
