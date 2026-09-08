/**
 * Writes an approved quotation into the reference library.
 *
 * One row per analysed photo, tagged with that photo's leak type and
 * severity but all pointing at the same final line items and price — that
 * keeps retrieval keyed by leak type even when one job covered several
 * distinct issues.
 *
 * Shared by the two paths that can approve: an administrator approving
 * their own quotation directly, and an administrator approving a
 * salesperson's quotation through review. Review passes amended values;
 * direct approval passes the quotation's own.
 */
export async function promoteToLibrary(client, opts) {
    // Replace anything an earlier approval of this quotation added, so
    // re-approving after an amendment corrects the library rather than
    // leaving the superseded wording beside the new.
    await client.query("DELETE FROM quotation_library WHERE quotation_id = $1", [opts.quotationId]);
    // A salesperson's correction wins over the model's guess: it is the
    // assessment the job was actually priced from, and it is what retrieval
    // will match future photos against.
    const { rows: photos } = await client.query(`SELECT id, COALESCE(corrected_analysis, ai_analysis) AS analysis, selected_repair_method
     FROM photos
     WHERE inspection_id = $1 AND COALESCE(corrected_analysis, ai_analysis) IS NOT NULL`, [opts.inspectionId]);
    // Carried onto every row so retrieval can prefer like-for-like references
    // later. Read from the inspection rather than passed in, so it is whatever
    // the job actually says at the moment of approval.
    const { rows: site } = await client.query("SELECT property_type FROM inspections WHERE id = $1", [
        opts.inspectionId,
    ]);
    const propertyType = site[0]?.property_type ?? null;
    for (const photo of photos) {
        await client.query(`INSERT INTO quotation_library
         (photo_id, quotation_id, review_id, leak_type, severity, line_items, final_price,
          source_type, ref_no, schedule_of_work, warranty_text, site_type, repair_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'generated', $8, $9, $10, $11, $12)`, [
            photo.id,
            opts.quotationId,
            opts.reviewId ?? null,
            opts.leakTypeOverride ?? photo.analysis.leak_type,
            photo.analysis.severity,
            JSON.stringify(opts.lineItems),
            opts.finalPrice,
            opts.refNo,
            opts.scheduleOfWork,
            opts.warrantyText,
            propertyType,
            // Which method this price actually bought. Without it the library
            // averages hacking and PU grouting into one figure that is right for
            // neither.
            photo.selected_repair_method,
        ]);
    }
    return photos.length;
}
