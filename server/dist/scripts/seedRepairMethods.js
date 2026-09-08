import { pool } from "../db/pool.js";
/**
 * A starting vocabulary of repair methods, and which diagnoses they suit.
 *
 * Written from the company's own wording — every method here is lifted from
 * an existing leak_types.typical_repair string or from the alternatives the
 * team described — plus the two non-invasive options that had no home before:
 * PU grouting instead of hacking, and exposed piping instead of opening a
 * wall.
 *
 * A STARTING POINT, not a rule: it is meant to be edited on the Training
 * page. Run once — it does not overwrite existing rows, and deliberately is
 * not part of schema.sql so that deleting a mapping makes it stay deleted.
 */
const METHODS = [
    {
        name: "PU grouting",
        description: "High pressure polyurethane injection grouting into the crack or joint, sealing it from within.",
        is_invasive: false,
        suitable_when: "Finishes are sound and the customer does not want tiles or screed broken up.",
        not_suitable_when: "The substrate is saturated or the finishes are already failing and due for replacement.",
    },
    {
        name: "Hack and re-waterproof",
        description: "Hack off the existing finishes, apply primer and waterproofing membrane to the slab, carry out a ponding test, then reinstate.",
        is_invasive: true,
        suitable_when: "Finishes are being replaced anyway, or the screed below is saturated.",
        not_suitable_when: "The space is occupied and the customer cannot lose the use of it.",
    },
    {
        name: "Hack and repair concealed pipe",
        description: "Hack open to expose the leaking concealed pipe, replace the affected section, patch and make good.",
        is_invasive: true,
        suitable_when: "The pipe run is short and accessible, and the customer wants the original layout kept.",
        not_suitable_when: "The run is long, buried deep, or under finishes the customer wants untouched.",
    },
    {
        name: "Bypass with exposed piping",
        description: "Abandon the concealed pipe in place and run new exposed piping along the surface to bypass it.",
        is_invasive: false,
        suitable_when: "The customer will accept visible pipework in exchange for no hacking.",
        not_suitable_when: "The run would cross a finished or visible area the customer wants kept clean.",
    },
    {
        name: "External facade sealing",
        description: "Access the facade by boomlift or rope access, hack V-grooves to enlarge the cracks, patch with epoxy putty or non-shrink grout, then apply external waterproof coating.",
        is_invasive: true,
        suitable_when: "The defect is on an external wall and the leak enters from outside.",
        not_suitable_when: "Access equipment cannot reach, or the source is internal.",
    },
    {
        name: "Reseal penetrations and junctions",
        description: "Reseal mounting points, roof penetrations and junctions, apply membrane or sealant at the joint, then make good the affected ceiling.",
        is_invasive: false,
        suitable_when: "The entry point is a bolt, a penetration or a junction rather than the field of the slab.",
        not_suitable_when: "The membrane over the whole area has failed.",
    },
    {
        name: "Replace seals and sealant",
        description: "Remove the damaged seals and apply new UV-resistant waterproofing sealant.",
        is_invasive: false,
        suitable_when: "The frame and glass are sound and only the sealant has perished.",
        not_suitable_when: "The frame itself has moved or corroded.",
    },
    {
        name: "Re-screed to fall",
        description: "Re-screed to correct the fall towards the outlet, apply waterproofing membrane, then carry out a ponding test.",
        is_invasive: true,
        suitable_when: "Water stands because the fall is wrong, not because the membrane has failed.",
        not_suitable_when: "The fall is already correct.",
    },
];
// Ordered: the method the company reaches for first comes first. Both are
// workable — that is the whole point — so this is preference, not correctness.
const MAP = {
    seepage: ["PU grouting", "Hack and re-waterproof"],
    "joint waterproofing failure": ["PU grouting", "Hack and re-waterproof"],
    crack: ["PU grouting", "Hack and re-waterproof"],
    "pipe leak": ["Hack and repair concealed pipe", "Bypass with exposed piping"],
    "external wall crack": ["External facade sealing", "PU grouting"],
    "roof leak": ["Reseal penetrations and junctions", "Hack and re-waterproof"],
    "window or door leak": ["Replace seals and sealant", "External facade sealing"],
    ponding: ["Re-screed to fall", "Hack and re-waterproof"],
    efflorescence: ["PU grouting", "Hack and re-waterproof"],
};
for (const m of METHODS) {
    await pool.query(`INSERT INTO repair_methods (name, description, is_invasive, suitable_when, not_suitable_when)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (name) DO NOTHING`, [m.name, m.description, m.is_invasive, m.suitable_when, m.not_suitable_when]);
}
let pairs = 0;
for (const [leakType, methods] of Object.entries(MAP)) {
    const { rows } = await pool.query("SELECT 1 FROM leak_types WHERE name = $1", [leakType]);
    if (rows.length === 0)
        continue;
    for (const [i, method] of methods.entries()) {
        const r = await pool.query(`INSERT INTO leak_type_methods (leak_type, method, position) VALUES ($1, $2, $3)
       ON CONFLICT (leak_type, method) DO NOTHING`, [leakType, method, i]);
        pairs += r.rowCount ?? 0;
    }
}
console.log(`methods: ${METHODS.length} | new leak-type/method pairs: ${pairs}`);
console.table((await pool.query(`SELECT m.leak_type, string_agg(m.method, '  ·  ' ORDER BY m.position) AS methods
         FROM leak_type_methods m GROUP BY m.leak_type ORDER BY m.leak_type`)).rows);
await pool.end();
