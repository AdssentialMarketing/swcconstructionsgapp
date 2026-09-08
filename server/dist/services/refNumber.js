import { pool } from "../db/pool.js";
// SWC26012SS: SWC + 2-digit year + 3-digit sequence + the preparer's
// initials. The suffix used to be a hardcoded "SS"; it is now whoever wrote
// the quotation, so the pattern accepts any two letters.
//
// A trailing "-2", "-3" and so on marks a revision: the client asked for
// changes after the quotation went out, and the team keeps the original
// number so both documents are visibly the same project. A revision is not
// a new quotation in the series — SWC26083SS-2 still belongs to number 83 —
// so it is parsed off and the base number is what counts.
const REF_NO_PATTERN = /^SWC(\d{2})(\d{3})([A-Za-z]{2})(?:-(\d+))?$/;
const DEFAULT_INITIALS = "SS";
export function parseRefNo(refNo) {
    const match = refNo.trim().match(REF_NO_PATTERN);
    if (!match)
        return null;
    return {
        year: Number(match[1]),
        sequence: Number(match[2]),
        initials: match[3].toUpperCase(),
        revision: match[4] ? Number(match[4]) : 1,
    };
}
/** True when a reference number is a revision of an earlier quotation rather than a new one. */
export function isRevision(refNo) {
    return (parseRefNo(refNo)?.revision ?? 1) > 1;
}
/**
 * Two initials from a full name: "Stanley Seow" -> SS, "Jonathan Tan" -> JT.
 *
 * Names with more than two words use the first and last ("Mary Jane Smith"
 * -> MS), since the ref number has room for exactly two letters. A
 * single-word name doubles its first letter rather than producing a
 * one-letter suffix that would not match the ref number format.
 */
export function initialsFromName(name) {
    const words = (name ?? "")
        .replace(/[^A-Za-z\s'-]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
    if (words.length === 0)
        return DEFAULT_INITIALS;
    if (words.length === 1) {
        const word = words[0].toUpperCase();
        return ((word[0] ?? "S") + (word[1] ?? word[0] ?? "S")).slice(0, 2);
    }
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
/** The initials a user signs with — their override if set, else from their name. */
export function initialsForUser(user) {
    const override = user.initials?.trim().toUpperCase();
    if (override && /^[A-Z]{2}$/.test(override))
        return override;
    return initialsFromName(user.name ?? "");
}
function formatRefNo(year, sequence, initials) {
    return `SWC${String(year).padStart(2, "0")}${String(sequence).padStart(3, "0")}${initials.toUpperCase()}`;
}
/**
 * Atomically claims the next sequence number in one salesperson's series.
 *
 * Each person numbers independently — that is what the trailing initials are
 * for. Stanley reaching SWC26001SS says nothing about Jonathan's next
 * number, which comes from his own counter. The row is keyed by (year,
 * initials), and the atomic upsert is what keeps two people saving at the
 * same moment from claiming the same number.
 */
export async function getNextRefNo(initials = DEFAULT_INITIALS) {
    const year = Number(String(new Date().getFullYear()).slice(-2));
    const series = initials.toUpperCase();
    const result = await pool.query(`INSERT INTO ref_number_counters (year, initials, last_sequence) VALUES ($1, $2, 1)
     ON CONFLICT (year, initials) DO UPDATE SET last_sequence = ref_number_counters.last_sequence + 1
     RETURNING last_sequence`, [year, series]);
    return formatRefNo(year, result.rows[0].last_sequence, series);
}
/**
 * Raises the floor of one person's series so newly generated numbers never
 * collide with one already issued — used when importing historical
 * quotations, whose numbers exist outside this database. Gaps in the
 * imported sequence are left alone rather than being filled in.
 */
export async function bumpRefNoFloor(year, sequence, initials = DEFAULT_INITIALS) {
    await pool.query(`INSERT INTO ref_number_counters (year, initials, last_sequence) VALUES ($1, $2, $3)
     ON CONFLICT (year, initials) DO UPDATE
       SET last_sequence = GREATEST(ref_number_counters.last_sequence, EXCLUDED.last_sequence)`, [year, initials.toUpperCase(), sequence]);
}
