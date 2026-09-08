import { Router } from "express";
import path from "node:path";
import { pool } from "../db/pool.js";
import { uploadPhotos } from "../middleware/upload.js";
import { analyzeInspectionPhotos } from "../services/claudeVision.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireOwnership } from "../middleware/access.js";
export const areasRouter = Router();
/**
 * Areas of a site, each with its own photos.
 *
 * A job routinely covers several distinct places, and each becomes its own
 * line item on the quotation. Keeping photos grouped is also what lets the
 * analysis read one area's photos together — sending every photo of a job in
 * one batch made it conflate a bathroom threshold with a carpark soffit.
 */
async function areaContext(areaId) {
    const { rows } = await pool.query(`SELECT a.id, a.name, i.id AS inspection_id, i.site_address, i.reported_issue
     FROM inspection_areas a JOIN inspections i ON i.id = a.inspection_id
     WHERE a.id = $1`, [areaId]);
    return rows[0] ?? null;
}
areasRouter.get("/inspections/:inspectionId/areas", requireOwnership("inspection", "inspectionId"), asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`SELECT a.id, a.name, a.position,
              COALESCE(json_agg(
                json_build_object(
                  'id', p.id, 'file_path', p.file_path, 'original_name', p.original_name,
                  'ai_analysis', p.ai_analysis, 'corrected_analysis', p.corrected_analysis,
                  'corrected_at', p.corrected_at,
                  'selected_repair_method', p.selected_repair_method
                ) ORDER BY p.id
              ) FILTER (WHERE p.id IS NOT NULL), '[]') AS photos
       FROM inspection_areas a
       LEFT JOIN photos p ON p.area_id = a.id
       WHERE a.inspection_id = $1
       GROUP BY a.id
       ORDER BY a.position, a.id`, [req.params.inspectionId]);
    res.json(rows);
}));
areasRouter.post("/inspections/:inspectionId/areas", requireOwnership("inspection", "inspectionId"), asyncHandler(async (req, res) => {
    const { name } = req.body ?? {};
    if (!name || typeof name !== "string" || name.trim() === "") {
        return res.status(400).json({ error: "An area needs a location name" });
    }
    const { rows: existing } = await pool.query("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM inspection_areas WHERE inspection_id = $1", [req.params.inspectionId]);
    const { rows } = await pool.query(`INSERT INTO inspection_areas (inspection_id, name, position)
       VALUES ($1, $2, $3) RETURNING id, name, position`, [req.params.inspectionId, name.trim(), existing[0].next]);
    res.status(201).json({ ...rows[0], photos: [] });
}));
areasRouter.put("/areas/:id", requireOwnership("area", "id"), asyncHandler(async (req, res) => {
    const { name } = req.body ?? {};
    if (!name || typeof name !== "string" || name.trim() === "") {
        return res.status(400).json({ error: "An area needs a location name" });
    }
    const { rows } = await pool.query("UPDATE inspection_areas SET name = $1 WHERE id = $2 RETURNING id, name, position", [name.trim(), req.params.id]);
    if (rows.length === 0)
        return res.status(404).json({ error: "Area not found" });
    res.json(rows[0]);
}));
areasRouter.delete("/areas/:id", requireOwnership("area", "id"), asyncHandler(async (req, res) => {
    // Photos are detached rather than deleted (ON DELETE SET NULL) so a
    // mis-clicked delete doesn't destroy uploaded evidence.
    const { rows } = await pool.query("DELETE FROM inspection_areas WHERE id = $1 RETURNING id", [req.params.id]);
    if (rows.length === 0)
        return res.status(404).json({ error: "Area not found" });
    res.json({ ok: true });
}));
/** Upload photos into one area, analysed together and in that area's context. */
areasRouter.post("/areas/:id/photos", requireOwnership("area", "id"), uploadPhotos.array("photos", 10), asyncHandler(async (req, res) => {
    const files = req.files;
    if (!files || files.length === 0)
        return res.status(400).json({ error: "No photos uploaded" });
    const area = await areaContext(req.params.id);
    if (!area)
        return res.status(404).json({ error: "Area not found" });
    let analyses = files.map(() => null);
    let analysisError = null;
    let summary = null;
    try {
        const result = await analyzeInspectionPhotos(files.map((file) => ({ filePath: file.path, mimeType: file.mimetype })), { siteAddress: area.site_address, reportedIssue: area.reported_issue, areaName: area.name });
        analyses = result.photos;
        summary = result.summary;
    }
    catch (err) {
        analysisError = err instanceof Error ? err.message : "Analysis failed";
    }
    const photos = [];
    for (const [i, file] of files.entries()) {
        const { rows } = await pool.query(`INSERT INTO photos (inspection_id, area_id, file_path, original_name, mime_type, size_bytes, ai_analysis)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, file_path, original_name, mime_type, uploaded_at, ai_analysis,
                   corrected_analysis, corrected_at`, [
            area.inspection_id,
            area.id,
            path.relative(process.cwd(), file.path),
            file.originalname,
            file.mimetype,
            file.size,
            analyses[i] ? JSON.stringify(analyses[i]) : null,
        ]);
        photos.push(rows[0]);
    }
    res.status(201).json({ photos, summary, analysis_error: analysisError });
}));
/** Re-run the analysis for one area, with everything currently known about it. */
areasRouter.post("/areas/:id/reanalyze", requireOwnership("area", "id"), asyncHandler(async (req, res) => {
    const area = await areaContext(req.params.id);
    if (!area)
        return res.status(404).json({ error: "Area not found" });
    const { rows: photos } = await pool.query("SELECT id, file_path, mime_type FROM photos WHERE area_id = $1 ORDER BY id", [req.params.id]);
    if (photos.length === 0)
        return res.status(400).json({ error: "This area has no photos to analyse." });
    const result = await analyzeInspectionPhotos(photos.map((p) => ({ filePath: path.join(process.cwd(), p.file_path), mimeType: p.mime_type })), { siteAddress: area.site_address, reportedIssue: area.reported_issue, areaName: area.name });
    for (const [i, photo] of photos.entries()) {
        await pool.query("UPDATE photos SET ai_analysis = $1 WHERE id = $2", [
            JSON.stringify(result.photos[i]),
            photo.id,
        ]);
    }
    res.json({ summary: result.summary, primary_leak_type: result.primaryLeakType });
}));
