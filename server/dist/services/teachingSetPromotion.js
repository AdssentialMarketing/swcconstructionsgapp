/**
 * Adds an approved job's photos to the teaching set future analyses learn from.
 *
 * Separate from promoteToLibrary on purpose: a job worth pricing from is not
 * automatically a photo worth showing the model. The library informs price
 * and wording; the teaching set informs what the model *sees*. Approving
 * offers both, and each is answered on its own.
 *
 * Shared by the two approval paths — an administrator approving their own
 * quotation, and an administrator approving a salesperson's through Review —
 * so the same job produces the same teaching examples either way. Before
 * this existed only the Review path could add photos, which meant an
 * administrator's own work could never teach the model at all.
 */
export async function addPhotosToTeachingSet(client, opts) {
    const { rows: photos } = await client.query(`SELECT p.id, p.file_path, COALESCE(p.corrected_analysis, p.ai_analysis) AS analysis,
            p.selected_repair_method,
            p.corrected_analysis IS NOT NULL AS was_corrected
       FROM photos p
      WHERE p.inspection_id = $1 AND COALESCE(p.corrected_analysis, p.ai_analysis) IS NOT NULL`, [opts.inspectionId]);
    let added = 0;
    for (const photo of photos) {
        // A photo teaches once. Re-approving a corrected quotation must not
        // stack duplicate examples of the same image.
        const { rows: already } = await client.query("SELECT id FROM leak_case_examples WHERE source_photo_id = $1", [photo.id]);
        if (already.length > 0)
            continue;
        await client.query(`INSERT INTO leak_case_examples
         (image_path, leak_type, severity, cause, location_notes, repair_approach, notes,
          source_photo_id, created_by, use_image, is_verified, chosen_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [
            photo.file_path,
            opts.leakTypeOverride ?? photo.analysis.leak_type,
            photo.analysis.severity,
            photo.analysis.cause,
            photo.analysis.location_notes,
            photo.analysis.suggested_repair_approach,
            `Approved from ${opts.sourceLabel}.`,
            photo.id,
            opts.userId ?? null,
            opts.useImage,
            // Verified means a person stood behind this assessment — either the
            // salesperson corrected it, or a reviewer retyped the leak type.
            // A photo carrying only the model's own untouched answer is not:
            // teaching the model from its own output entrenches its mistakes,
            // and selectTeachingSet ranks verified examples first so these are
            // used only when there is room left over.
            photo.was_corrected || opts.leakTypeOverride != null,
            // What was actually done, so the example teaches "this was chosen
            // here" rather than "the alternative was wrong".
            photo.selected_repair_method,
        ]);
        added += 1;
    }
    return added;
}
