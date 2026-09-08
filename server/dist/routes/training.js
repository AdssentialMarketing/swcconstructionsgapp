import { Router } from "express";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { pool } from "../db/pool.js";
import { uploadPhotos } from "../middleware/upload.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { listLeakTypes, resolveLeakType } from "../services/leakTypes.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { selectTeachingSet, CASES_PER_LEAK_TYPE, MAX_EXAMPLE_IMAGES } from "../services/teachingSet.js";
import { countLeakTypeUsage, deleteLeakType, renameLeakTypeEverywhere } from "../services/leakTypeMaintenance.js";
export const trainingRouter = Router();
// ---------------------------------------------------------------------------
// Leak type vocabulary
// ---------------------------------------------------------------------------
// Readable by everyone: the vocabulary is what fills the leak type dropdown
// when a salesperson corrects a photo's assessment on their own job. Only
// changing it is restricted.
trainingRouter.get("/leak-types", asyncHandler(async (req, res) => {
    const types = await listLeakTypes(false);
    // Usage counts only matter to the page that edits the vocabulary, and
    // they cost a handful of queries, so they are opt-in.
    if (req.query.usage !== "true")
        return res.json(types);
    res.json(await Promise.all(types.map(async (type) => ({ ...type, usage: await countLeakTypeUsage(type.name) }))));
}));
trainingRouter.post("/leak-types", requireAdmin, asyncHandler(async (req, res) => {
    const { name, description, typical_cause, typical_repair } = req.body ?? {};
    if (!name || typeof name !== "string" || name.trim() === "") {
        return res.status(400).json({ error: "name is required" });
    }
    const { rows } = await pool.query(`INSERT INTO leak_types (name, description, typical_cause, typical_repair)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE
         SET description = EXCLUDED.description,
             typical_cause = EXCLUDED.typical_cause,
             typical_repair = EXCLUDED.typical_repair
       RETURNING *`, [name.trim().toLowerCase(), description ?? null, typical_cause ?? null, typical_repair ?? null]);
    res.status(201).json(rows[0]);
}));
trainingRouter.put("/leak-types/:id", requireAdmin, asyncHandler(async (req, res) => {
    const { name, description, typical_cause, typical_repair, is_active } = req.body ?? {};
    const { rows: existing } = await pool.query("SELECT name FROM leak_types WHERE id = $1", [req.params.id]);
    if (existing.length === 0)
        return res.status(404).json({ error: "Leak type not found" });
    const currentName = existing[0].name;
    const newName = typeof name === "string" ? name.trim().toLowerCase() : null;
    if (newName === "")
        return res.status(400).json({ error: "A leak type needs a name" });
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        if (newName && newName !== currentName) {
            const { rows: clash } = await client.query("SELECT id FROM leak_types WHERE name = $1", [newName]);
            if (clash.length > 0) {
                await client.query("ROLLBACK");
                return res.status(409).json({
                    error: `"${newName}" already exists. To merge the two, delete this one and reassign its work to "${newName}".`,
                });
            }
            // The name is the join key retrieval matches on, so every copy of it
            // moves with the rename — otherwise past work keeps a tag nothing
            // looks for, and drafts quietly stop finding pricing references.
            await renameLeakTypeEverywhere(client, currentName, newName);
        }
        const { rows } = await client.query(`UPDATE leak_types
         SET description = COALESCE($1, description),
             typical_cause = COALESCE($2, typical_cause),
             typical_repair = COALESCE($3, typical_repair),
             is_active = COALESCE($4, is_active)
         WHERE id = $5 RETURNING *`, [description ?? null, typical_cause ?? null, typical_repair ?? null, is_active ?? null, req.params.id]);
        await client.query("COMMIT");
        res.json({ ...rows[0], renamed_from: newName && newName !== currentName ? currentName : null });
    }
    catch (err) {
        await client.query("ROLLBACK");
        throw err;
    }
    finally {
        client.release();
    }
}));
trainingRouter.delete("/leak-types/:id", requireAdmin, asyncHandler(async (req, res) => {
    const { reassign_to } = req.body ?? {};
    const { rows } = await pool.query("SELECT name FROM leak_types WHERE id = $1", [req.params.id]);
    if (rows.length === 0)
        return res.status(404).json({ error: "Leak type not found" });
    const name = rows[0].name;
    const usage = await countLeakTypeUsage(name);
    if (usage.total > 0 && !reassign_to) {
        return res.status(409).json({
            error: `"${name}" is still used by ${usage.total} record(s). Choose a leak type to move them to first.`,
            usage,
        });
    }
    if (reassign_to) {
        const target = await listLeakTypes(false);
        if (!target.some((t) => t.name === reassign_to)) {
            return res.status(400).json({ error: `"${reassign_to}" is not a known leak type.` });
        }
        if (reassign_to === name) {
            return res.status(400).json({ error: "Choose a different leak type to move the work to." });
        }
    }
    const moved = await deleteLeakType(name, reassign_to ?? null);
    res.json({ ok: true, deleted: name, reassigned_to: reassign_to ?? null, moved });
}));
// ---------------------------------------------------------------------------
// Teaching set — labelled past cases shown to the model as worked examples
// ---------------------------------------------------------------------------
trainingRouter.get("/case-examples", requireAdmin, asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`SELECT id, image_path, leak_type, severity, cause, location_notes, repair_approach, notes,
              source_photo_id, use_image, is_active, is_pinned, is_verified, created_at
       FROM leak_case_examples
       ORDER BY leak_type, is_pinned DESC, is_verified DESC, created_at DESC`);
    // Only a couple of cases per leak type reach the prompt, so the page has
    // to say which — otherwise a switch is toggled on a case that is never
    // sent and nothing changes, with no way to tell.
    const { chosen, imageIds } = await selectTeachingSet();
    const chosenIds = new Set(chosen.map((c) => c.id));
    res.json({
        cases: rows.map((row) => ({
            ...row,
            sent_to_model: chosenIds.has(row.id),
            sent_as_image: imageIds.has(row.id),
        })),
        limits: {
            cases_per_leak_type: CASES_PER_LEAK_TYPE,
            max_example_images: MAX_EXAMPLE_IMAGES,
            sent_total: chosen.length,
            sent_as_images: imageIds.size,
        },
    });
}));
/** Seed a past case directly, by uploading its photo along with the correct labels. */
trainingRouter.post("/case-examples", requireAdmin, uploadPhotos.single("photo"), asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file)
        return res.status(400).json({ error: "A photo is required" });
    const { leak_type, severity, cause, location_notes, repair_approach, notes } = req.body ?? {};
    const vocabulary = await listLeakTypes(false);
    const { leakType, matched } = resolveLeakType(leak_type, vocabulary);
    if (!matched) {
        await unlink(file.path).catch(() => { });
        return res.status(400).json({
            error: `"${leak_type}" is not a known leak type. Pick one of: ${vocabulary.map((t) => t.name).join(", ")}.`,
        });
    }
    const { rows } = await pool.query(`INSERT INTO leak_case_examples
         (image_path, leak_type, severity, cause, location_notes, repair_approach, notes, created_by, is_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       RETURNING *`, [
        path.relative(process.cwd(), file.path),
        leakType,
        severity || null,
        cause || null,
        location_notes || null,
        repair_approach || null,
        notes || null,
        req.session.userId ?? null,
    ]);
    res.status(201).json(rows[0]);
}));
trainingRouter.put("/case-examples/:id", requireAdmin, asyncHandler(async (req, res) => {
    const { leak_type, severity, cause, location_notes, repair_approach, notes, use_image, is_active, is_pinned, is_verified } = req.body ?? {};
    let leakType = null;
    if (leak_type !== undefined) {
        const vocabulary = await listLeakTypes(false);
        const resolved = resolveLeakType(leak_type, vocabulary);
        if (!resolved.matched)
            return res.status(400).json({ error: `"${leak_type}" is not a known leak type.` });
        leakType = resolved.leakType;
    }
    const { rows } = await pool.query(`UPDATE leak_case_examples
       SET leak_type = COALESCE($1, leak_type),
           severity = COALESCE($2, severity),
           cause = COALESCE($3, cause),
           location_notes = COALESCE($4, location_notes),
           repair_approach = COALESCE($5, repair_approach),
           notes = COALESCE($6, notes),
           use_image = COALESCE($7, use_image),
           is_active = COALESCE($8, is_active),
           is_pinned = COALESCE($9, is_pinned),
           is_verified = COALESCE($10, is_verified)
       WHERE id = $11 RETURNING *`, [
        leakType,
        severity ?? null,
        cause ?? null,
        location_notes ?? null,
        repair_approach ?? null,
        notes ?? null,
        use_image ?? null,
        is_active ?? null,
        is_pinned ?? null,
        is_verified ?? null,
        req.params.id,
    ]);
    if (rows.length === 0)
        return res.status(404).json({ error: "Case example not found" });
    res.json(rows[0]);
}));
trainingRouter.delete("/case-examples/:id", requireAdmin, asyncHandler(async (req, res) => {
    const { rows } = await pool.query("DELETE FROM leak_case_examples WHERE id = $1 RETURNING image_path, source_photo_id", [req.params.id]);
    if (rows.length === 0)
        return res.status(404).json({ error: "Case example not found" });
    // Only remove the image file for cases seeded directly here. One promoted
    // from an inspection shares its file with that photo, which must keep it.
    if (!rows[0].source_photo_id) {
        await unlink(path.join(process.cwd(), rows[0].image_path)).catch(() => { });
    }
    res.json({ ok: true });
}));
