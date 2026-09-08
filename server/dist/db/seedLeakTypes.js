import { pool } from "./pool.js";
// Starter vocabulary, derived from the work the six quotations in samples/
// actually describe rather than from a generic list:
//
//   PU injection grouting to wall/floor joints and cracklines  -> crack
//   cementitious / microfiber membrane over damp areas         -> seepage
//   hacking method, replace leaking water supply pipe          -> pipe leak
//   awning fixing points, roof/wall junction penetrations      -> roof leak
//   boomlift + rope access to a facade                         -> external wall leak
//
// Seeded with ON CONFLICT DO NOTHING so it is safe to re-run and never
// overwrites wording the team has edited. The list is meant to be edited and
// extended in the app — these definitions are what the vision model uses to
// classify, so they should read the way the team actually talks.
const LEAK_TYPES = [
    {
        name: "crack",
        description: "A visible crack line in a wall, floor, slab or soffit, often running along a construction joint or at a wall-to-floor junction. May be hairline and dry-looking, or show staining along its length.",
        typical_cause: "Structural movement, shrinkage, or a failed construction joint letting water track through the element.",
        typical_repair: "High pressure polyurethane injection grouting to seal the crack and joints, followed by primer and waterproofing membrane over the affected area.",
    },
    {
        name: "seepage",
        description: "Damp patches, darkened areas or blistered/peeling paint spreading across a wall, ceiling or floor with no single visible crack. Often diffuse, with a tide line at the edge.",
        typical_cause: "Water migrating through porous concrete or masonry, usually from a wet area, planter or external surface on the other side of the element.",
        typical_repair: "Apply primer and waterproofing membrane to the affected area; hack off and reinstate finishes where the substrate is saturated.",
    },
    {
        name: "pipe leak",
        description: "Localised wet patch, drip or active water directly around concealed or exposed pipework — under sinks, along pipe chases, or at a ceiling directly below a wet area.",
        typical_cause: "A failed joint, corroded section, or split in a water supply or waste pipe.",
        typical_repair: "Hack open to expose the leaking pipe, replace the affected section, then patch and make good the opened area.",
    },
    {
        name: "roof leak",
        description: "Staining, blistering or peeling on a ceiling or soffit, typically worst near a penetration — an awning fixing, bolt, pipe sleeve or roof/wall junction directly above.",
        typical_cause: "Water entering through a poorly sealed roof penetration, fixing point or flashing and tracking along the slab before showing internally.",
        typical_repair: "Reseal the mounting points and roof penetrations, apply waterproof membrane or sealant at the junction, then make good and repaint the affected ceiling.",
    },
    {
        name: "external wall leak",
        description: "Damp showing on the inside face of an external wall, or defective sealant, cracks and spalling visible on the facade itself. Often worse after driving rain.",
        typical_cause: "Failed facade sealant, cracked render, or defective window/opening perimeter allowing wind-driven rain through the external envelope.",
        typical_repair: "Access the facade (boomlift or rope access), rake out and reseal defective joints, patch cracks, and apply external waterproof coating.",
    },
    {
        name: "joint failure",
        description: "Perished, split or missing sealant at a junction — wall to floor, around a window or door frame, at a threshold, or where a fixing penetrates the structure.",
        typical_cause: "Sealant reaching end of life, or movement at the joint breaking the bond.",
        typical_repair: "Rake out the failed sealant, clean the joint, and reseal; apply membrane over the junction where exposed.",
    },
    {
        name: "efflorescence",
        description: "White, powdery or crystalline salt deposits on the face of concrete, render or tile grout, sometimes with staining around it.",
        typical_cause: "Long-standing moisture movement through the element carrying soluble salts to the surface — a symptom of persistent water ingress rather than the leak itself.",
        typical_repair: "Trace and treat the underlying water ingress first, then clean off deposits and reinstate the finish.",
    },
    {
        name: "ponding",
        description: "Standing water sitting on a floor, balcony, roof or gully long after rain or use, often with a visible tide mark where it repeatedly settles.",
        typical_cause: "Insufficient fall to the drainage point, a blocked outlet, or a settled/deformed slab.",
        typical_repair: "Re-screed to correct the fall towards the outlet, then apply waterproofing membrane and carry out a ponding test.",
    },
    {
        name: "other",
        description: "Use only when the photo genuinely does not fit any type above — for example it shows no water-related defect at all, or shows a defect outside waterproofing scope.",
        typical_cause: "",
        typical_repair: "",
    },
];
async function seed() {
    for (const type of LEAK_TYPES) {
        await pool.query(`INSERT INTO leak_types (name, description, typical_cause, typical_repair)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO NOTHING`, [type.name, type.description, type.typical_cause, type.typical_repair]);
    }
    const { rows } = await pool.query("SELECT name, is_active FROM leak_types ORDER BY name");
    console.log(`Leak type vocabulary (${rows.length}):`);
    for (const row of rows)
        console.log(`  ${row.is_active ? " " : "x"} ${row.name}`);
    await pool.end();
}
seed().catch((err) => {
    console.error("Seeding leak types failed:", err);
    process.exit(1);
});
