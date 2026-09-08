import { pool } from "../db/pool.js";
/**
 * Invoice numbers: SWC2026111.
 *
 * One company-wide series with the full four-digit year and no salesperson
 * initials — unlike quotation references, which end in the initials of
 * whoever wrote them. An invoice comes from the company, not from the
 * salesperson, and is raised by accounts.
 *
 * The sequence restarts each year.
 */
const PREFIX = "SWC";
const SEQUENCE_DIGITS = 3;
export function formatInvoiceNo(year, sequence) {
    return `${PREFIX}${year}${String(sequence).padStart(SEQUENCE_DIGITS, "0")}`;
}
export function parseInvoiceNo(value) {
    const match = value.trim().toUpperCase().match(/^SWC(\d{4})(\d{3,})$/);
    if (!match)
        return null;
    return { year: Number(match[1]), sequence: Number(match[2]) };
}
/**
 * Claims the next number in this year's series.
 *
 * The atomic upsert is what stops two people issuing invoices at the same
 * moment from claiming the same number — the same guard the quotation
 * counter uses.
 */
export async function getNextInvoiceNo() {
    const year = new Date().getFullYear();
    const { rows } = await pool.query(`INSERT INTO invoice_number_counters (year, last_sequence) VALUES ($1, 1)
     ON CONFLICT (year) DO UPDATE SET last_sequence = invoice_number_counters.last_sequence + 1
     RETURNING last_sequence`, [year]);
    return formatInvoiceNo(year, rows[0].last_sequence);
}
/**
 * Raises the floor of the series so newly issued numbers never collide with
 * one already sent to a customer — used when the historical invoices were
 * numbered outside this system, as they all were up to now.
 */
export async function bumpInvoiceNoFloor(year, sequence) {
    await pool.query(`INSERT INTO invoice_number_counters (year, last_sequence) VALUES ($1, $2)
     ON CONFLICT (year) DO UPDATE
       SET last_sequence = GREATEST(invoice_number_counters.last_sequence, EXCLUDED.last_sequence)`, [year, sequence]);
}
