// The "Schedule of work" and "Warranty" lines are printed onto the
// quotation verbatim, right after a fixed label, so they have to read as
// whole sentences. In practice both the AI draft and the salesperson tend
// to supply just the number ("3", "24"), which reached the customer's
// document as ": 3" and ": 24".
//
// The trailing wording is boilerplate — identical across every file in
// samples/ apart from the leading duration — so it is composed here instead
// of being retyped. Anything that already reads as a sentence is passed
// through untouched, so a one-off variant ("9-10 working day(s) subjected to
// weather conditions for each unit") can still be written by hand.
const SCHEDULE_SUFFIX = "working day(s) subjected to weather conditions";
const WARRANTY_SUFFIX = "months from date of invoice for area(s) of work against water leakage only";
/** A bare duration: "3", "24", or a range like "25-28". */
const DURATION_ONLY = /^\d+\s*(?:-\s*\d+)?$/;
const ONES = [
    "ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE",
    "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN",
    "SEVENTEEN", "EIGHTEEN", "NINETEEN",
];
const TENS = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];
/** Spells a whole number the way the quotations do: 12 -> TWELVE, 24 -> TWENTY-FOUR. */
export function numberToWords(value) {
    if (!Number.isInteger(value) || value < 0 || value > 999)
        return String(value);
    if (value < 20)
        return ONES[value];
    if (value < 100) {
        const tens = TENS[Math.floor(value / 10)];
        const ones = value % 10;
        return ones === 0 ? tens : `${tens}-${ONES[ones]}`;
    }
    const hundreds = `${ONES[Math.floor(value / 100)]} HUNDRED`;
    const rest = value % 100;
    return rest === 0 ? hundreds : `${hundreds} AND ${numberToWords(rest)}`;
}
function normaliseDuration(input) {
    const value = typeof input === "string" ? input.trim() : "";
    return value === "" ? null : value;
}
/**
 * "3" becomes "3 working day(s) subjected to weather conditions"; an
 * already-complete sentence is left alone.
 */
export function normaliseScheduleOfWork(input) {
    const value = normaliseDuration(input);
    if (value === null)
        return null;
    if (!DURATION_ONLY.test(value))
        return value;
    return `${value.replace(/\s+/g, "")} ${SCHEDULE_SUFFIX}`;
}
/**
 * "24" becomes "24 (TWENTY-FOUR) months from date of invoice for area(s) of
 * work against water leakage only"; an already-complete sentence is left
 * alone. A range is spelled from its upper bound, matching how the samples
 * word a warranty.
 */
export function normaliseWarrantyText(input) {
    const value = normaliseDuration(input);
    if (value === null)
        return null;
    if (!DURATION_ONLY.test(value))
        return value;
    const compact = value.replace(/\s+/g, "");
    const months = Number(compact.split("-").pop());
    return `${compact} (${numberToWords(months)}) ${WARRANTY_SUFFIX}`;
}
