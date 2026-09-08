import { pool } from "../db/pool.js";
import { resolveMethods, listRepairMethods } from "../services/leakTypes.js";
console.log("what drafting sees:");
console.log((await pool.query(`SELECT COALESCE(corrected_analysis, ai_analysis)
            || jsonb_build_object('chosen_method', to_jsonb(selected_repair_method)) AS analysis
     FROM photos WHERE inspection_id = 33 ORDER BY id`)).rows.map((r) => `  ${r.analysis.leak_type} -> chosen_method: ${JSON.stringify(r.analysis.chosen_method)}`).join("\n"));
const methods = await listRepairMethods();
console.log("\nresolveMethods:");
console.log("  model offers both, valid      :", resolveMethods([{ method: "PU grouting", rationale: "finishes are sound" }, { method: "Hack and re-waterproof", rationale: "screed saturated" }], methods, "seepage").map((m) => `${m.method}(${m.is_invasive ? "inv" : "non"})`).join(", "));
console.log("  model invents one             :", resolveMethods([{ method: "Magic sealant", rationale: "x" }], methods, "seepage").map((m) => m.method).join(", "), "  <- falls back to the full list for the diagnosis");
console.log("  model offers a wrong-type one :", resolveMethods([{ method: "Re-screed to fall", rationale: "x" }], methods, "pipe leak").map((m) => m.method).join(", "));
console.log("  model returns nothing         :", resolveMethods(undefined, methods, "pipe leak").map((m) => m.method).join(", "));
console.log("  duplicates collapse           :", resolveMethods([{ method: "PU grouting", rationale: "a" }, { method: "pu GROUTING", rationale: "b" }], methods, "crack").map((m) => m.method).join(", "));
await pool.end();
