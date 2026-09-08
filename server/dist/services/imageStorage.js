import path from "node:path";
import { unlink, writeFile } from "node:fs/promises";
import sharp from "sharp";
/**
 * Normalises an uploaded photo to exactly what the model is shown.
 *
 * Anthropic downscales anything past 1568px on its long edge, so a full
 * resolution phone photo buys no extra detail — it was already being resized
 * to these numbers in memory on every analysis and then thrown away. Keeping
 * the original as well cost about 2.5MB per photo, against roughly 300KB for
 * the version that actually gets used, and nothing ever read the difference.
 *
 * So the resized image is what gets stored. The bytes on disk are now the
 * bytes the model sees, which also makes the resize at analysis time a
 * no-op pass rather than real work on every request.
 *
 * Everything is stored as JPEG, including PNG and WEBP uploads: a 1568px PNG
 * photograph is several times the size of the same JPEG and no better, and
 * one format on disk means one thing to reason about.
 */
// Anthropic's own limit. Above this the API resizes anyway.
export const MAX_IMAGE_EDGE_PX = 1568;
export const JPEG_QUALITY = 82;
/**
 * Rewrites the file at `absolutePath` in place, returning where it ended up.
 *
 * An unreadable file (an odd format, a truncated upload) is left alone
 * rather than failing the upload: the salesperson is on site and losing
 * their photo matters more than the disk space.
 */
export async function normaliseStoredImage(absolutePath) {
    try {
        const buffer = await sharp(absolutePath)
            .rotate() // honour EXIF orientation, which is lost once re-encoded
            .resize({
            width: MAX_IMAGE_EDGE_PX,
            height: MAX_IMAGE_EDGE_PX,
            fit: "inside",
            withoutEnlargement: true,
        })
            .jpeg({ quality: JPEG_QUALITY })
            .toBuffer();
        const target = absolutePath.replace(/\.[^.]+$/, "") + ".jpg";
        await writeFile(target, buffer);
        // Only once the replacement is safely written, and never the file we
        // just wrote — a .jpg upload keeps its own name.
        if (target !== absolutePath)
            await unlink(absolutePath).catch(() => { });
        return { filePath: target, mimeType: "image/jpeg", sizeBytes: buffer.length, normalised: true };
    }
    catch {
        return {
            filePath: absolutePath,
            mimeType: `image/${path.extname(absolutePath).slice(1).toLowerCase() || "jpeg"}`,
            sizeBytes: 0,
            normalised: false,
        };
    }
}
