import { Router } from "express";
import path from "node:path";
import { pool } from "../db/pool.js";
import { normaliseStoredImage } from "../services/imageStorage.js";
/** How many photos are resized at once — see the upload handler. */
const IMAGE_BATCH = 3;
import { uploadPhotos } from "../middleware/upload.js";
import { analyzeInspectionPhotos } from "../services/claudeVision.js";
import { listLeakTypes, resolveLeakType } from "../services/leakTypes.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { isAdmin } from "../middleware/requireAdmin.js";
import { requireOwnership } from "../middleware/access.js";
export const photosRouter = Router();
async function inspectionContext(inspectionId) {
    const { rows } = await pool.query("SELECT site_address, reported_issue FROM inspections WHERE id = $1", [inspectionId]);
    if (rows.length === 0)
        return { found: false };
    return { found: true, siteAddress: rows[0].site_address, reportedIssue: rows[0].reported_issue };
}
// Upload 1+ photos for an inspection, then analyze the batch via Claude.
photosRouter.post("/inspections/:inspectionId/photos", requireOwnership("inspection", "inspectionId"), uploadPhotos.array("photos", 10), asyncHandler(async (req, res) => {
    const files = req.files;
    if (!files || files.length === 0) {
        return res.status(400).json({ error: "No photos uploaded" });
    }
    const context = await inspectionContext(req.params.inspectionId);
    if (!context.found) {
        return res.status(404).json({ error: "Inspection not found" });
    }
    // Shrink to what the model is actually shown before anything else sees
    // the file. Done here rather than in multer so the original is on disk
    // and recoverable if sharp cannot read it.
    //
    // A few at a time rather than all ten at once: decoding ten 10MB phone
    // photos in parallel is the memory high-water mark of the whole app, and
    // it would decide how much RAM the server needs for work that takes well
    // under a second either way.
    const stored = [];
    for (let i = 0; i < files.length; i += IMAGE_BATCH) {
        stored.push(...(await Promise.all(files.slice(i, i + IMAGE_BATCH).map((file) => normaliseStoredImage(file.path)))));
    }
    // Store a web-servable relative path (e.g. "uploads/xxx.jpg"), not the
    // absolute disk path multer gives us — express.static serves /uploads
    // from process.cwd()/uploads, and the frontend builds image URLs as
    // `/${file_path}`.
    const relativePaths = stored.map((s) => path.relative(process.cwd(), s.filePath));
    // All photos of a job go to the model together: several often show the
    // same defect from different angles, and one may show the source of a
    // problem another shows the damage from.
    let analyses = files.map(() => null);
    let analysisError = null;
    let summary = null;
    try {
        const result = await analyzeInspectionPhotos(stored.map((s) => ({ filePath: s.filePath, mimeType: s.mimeType })), context);
        analyses = result.photos;
        summary = result.summary;
    }
    catch (err) {
        analysisError = err instanceof Error ? err.message : "Analysis failed";
    }
    const results = [];
    for (const [i, file] of files.entries()) {
        const inserted = await pool.query(`INSERT INTO photos (inspection_id, file_path, original_name, mime_type, size_bytes, ai_analysis)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, file_path, original_name, mime_type, uploaded_at, ai_analysis,
                   corrected_analysis, corrected_at, selected_repair_method`, [
            req.params.inspectionId,
            relativePaths[i],
            file.originalname,
            // The stored file's type and size, not the upload's — a 6MB HEIC-ish
            // JPEG that came in is a 300KB JPEG by the time it is written.
            stored[i].mimeType,
            stored[i].normalised ? stored[i].sizeBytes : file.size,
            analyses[i] ? JSON.stringify(analyses[i]) : null,
        ]);
        results.push({ ...inserted.rows[0], analysis_error: analysisError });
    }
    res.status(201).json({ photos: results, summary, analysis_error: analysisError });
}));
// Re-run analysis across every photo of an inspection, so they are judged
// together and against the current teaching set.
photosRouter.post("/inspections/:inspectionId/reanalyze", requireOwnership("inspection", "inspectionId"), asyncHandler(async (req, res) => {
    const context = await inspectionContext(req.params.inspectionId);
    if (!context.found) {
        return res.status(404).json({ error: "Inspection not found" });
    }
    const { rows: photos } = await pool.query("SELECT id, file_path, mime_type FROM photos WHERE inspection_id = $1 ORDER BY id", [req.params.inspectionId]);
    if (photos.length === 0) {
        return res.status(400).json({ error: "This inspection has no photos to analyse." });
    }
    const result = await analyzeInspectionPhotos(photos.map((photo) => ({
        filePath: path.join(process.cwd(), photo.file_path),
        mimeType: photo.mime_type,
    })), context);
    for (const [i, photo] of photos.entries()) {
        await pool.query("UPDATE photos SET ai_analysis = $1 WHERE id = $2", [
            JSON.stringify(result.photos[i]),
            photo.id,
        ]);
    }
    res.json({ summary: result.summary, primary_leak_type: result.primaryLeakType, photo_count: photos.length });
}));
// Re-run analysis on a single photo (e.g. after a failure).
photosRouter.post("/photos/:photoId/reanalyze", requireOwnership("photo", "photoId"), asyncHandler(async (req, res) => {
    const photoResult = await pool.query("SELECT * FROM photos WHERE id = $1", [req.params.photoId]);
    const photo = photoResult.rows[0];
    if (!photo) {
        return res.status(404).json({ error: "Photo not found" });
    }
    const context = await inspectionContext(photo.inspection_id);
    const result = await analyzeInspectionPhotos([{ filePath: path.join(process.cwd(), photo.file_path), mimeType: photo.mime_type }], context);
    const updated = await pool.query(`UPDATE photos SET ai_analysis = $1 WHERE id = $2
       RETURNING id, file_path, ai_analysis, corrected_analysis, corrected_at`, [JSON.stringify(result.photos[0]), req.params.photoId]);
    res.json(updated.rows[0]);
}));
/**
 * Record the salesperson's corrected assessment of a photo.
 *
 * Stored beside the AI's answer rather than over it, so the two stay
 * comparable, and optionally promoted into the teaching set so future
 * analyses learn from it.
 */
/**
 * Records which repair method this photo's work will be quoted at.
 *
 * Deliberately NOT part of the correction endpoint. Correcting an analysis
 * says the model misread the photo; choosing a method says nothing of the
 * kind — hacking and PU grouting are both right, and which is quoted is
 * agreed with the customer. Routing this through corrections taught the
 * teaching set that correct readings were mistakes.
 *
 * Any salesperson may choose, on their own job: this is a commercial
 * decision about one quotation, not a change to what the model is taught.
 */
photosRouter.put("/photos/:photoId/repair-method", asyncHandler(async (req, res) => {
    const { method } = req.body ?? {};
    const { rows: owned } = await pool.query(`SELECT p.id, COALESCE(p.corrected_analysis, p.ai_analysis) AS analysis
         FROM photos p JOIN inspections i ON i.id = p.inspection_id
        WHERE p.id = $1 AND (i.created_by = $2 OR $3)`, [req.params.photoId, req.session.userId, await isAdmin(req.session.userId)]);
    if (owned.length === 0)
        return res.status(404).json({ error: "Photo not found" });
    if (method !== null) {
        // Only a method the company actually offers for THIS diagnosis. A free
        // text method would never match a pricing reference and would put work
        // on a quotation that nobody has costed.
        const { rows: allowed } = await pool.query(`SELECT 1 FROM leak_type_methods m JOIN repair_methods r ON r.name = m.method
          WHERE m.leak_type = $1 AND m.method = $2 AND r.is_active`, [owned[0].analysis?.leak_type ?? "", method]);
        if (allowed.length === 0) {
            return res.status(400).json({ error: "That repair method is not listed for this kind of defect." });
        }
    }
    const { rows } = await pool.query(`UPDATE photos
          SET selected_repair_method = $1, selected_method_at = now(), selected_method_by = $2
        WHERE id = $3
        RETURNING id, file_path, ai_analysis, corrected_analysis, selected_repair_method`, [method ?? null, req.session.userId ?? null, req.params.photoId]);
    res.json(rows[0]);
}));
photosRouter.put("/photos/:photoId/analysis", requireOwnership("photo", "photoId"), asyncHandler(async (req, res) => {
    const { leak_type, severity, cause, location_notes, suggested_repair_approach, add_to_teaching_set, notes } = req.body ?? {};
    const photoResult = await pool.query("SELECT * FROM photos WHERE id = $1", [req.params.photoId]);
    const photo = photoResult.rows[0];
    if (!photo) {
        return res.status(404).json({ error: "Photo not found" });
    }
    const vocabulary = await listLeakTypes(false);
    const { leakType, matched } = resolveLeakType(leak_type, vocabulary);
    if (!matched) {
        return res.status(400).json({
            error: `"${leak_type}" is not a known leak type. Pick one of: ${vocabulary.map((t) => t.name).join(", ")}.`,
        });
    }
    const corrected = {
        leak_type: leakType,
        severity: severity ?? "minor",
        cause: cause ?? "",
        location_notes: location_notes ?? "",
        suggested_repair_approach: suggested_repair_approach ?? "",
        // A human-confirmed assessment is certain by definition; the AI's own
        // score stays on the untouched ai_analysis for comparison.
        confidence: 1,
    };
    const updated = await pool.query(`UPDATE photos
       SET corrected_analysis = $1, corrected_at = now(), corrected_by = $2
       WHERE id = $3
       RETURNING id, file_path, ai_analysis, corrected_analysis, corrected_at`, [JSON.stringify(corrected), req.session.userId ?? null, req.params.photoId]);
    // Correcting an assessment is ordinary work — it is how a salesperson
    // gets their own quotation right. Promoting one into the teaching set
    // changes what every future analysis is shown, so that stays with
    // administrators.
    //
    // Refusing the promotion is reported as a warning on a successful
    // response rather than an error status: the correction itself was
    // saved, and a 403 would make the client treat the whole call as failed
    // and leave the salesperson thinking their fix was lost.
    const mayTeach = await isAdmin(req.session.userId);
    const teachingWarning = add_to_teaching_set && !mayTeach
        ? "Your correction was saved. Only administrators can add a case to the teaching set — ask one to add it."
        : null;
    if (add_to_teaching_set && mayTeach) {
        await pool.query(`INSERT INTO leak_case_examples
           (image_path, leak_type, severity, cause, location_notes, repair_approach, notes,
            source_photo_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
            photo.file_path,
            corrected.leak_type,
            corrected.severity,
            corrected.cause,
            corrected.location_notes,
            corrected.suggested_repair_approach,
            notes ?? null,
            photo.id,
            req.session.userId ?? null,
        ]);
    }
    res.json({ ...updated.rows[0], teaching_warning: teachingWarning });
}));
