/**
 * Lowercase roman numerals for the sub-locations under a grouped line item.
 *
 * i, ii, iii, iv — the company's own quotations and invoices list places this
 * way, not a, b, c.
 */
export function locationMarker(index) {
    const numerals = [
        [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"],
        [100, "c"], [90, "xc"], [50, "l"], [40, "xl"],
        [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
    ];
    let n = index + 1;
    let out = "";
    for (const [value, symbol] of numerals) {
        while (n >= value) {
            out += symbol;
            n -= value;
        }
    }
    return out;
}
/**
 * Writes the places a grouped item covers underneath its description.
 *
 * Assembled here rather than asked of the model, so the layout is identical
 * on every quotation:
 *
 *   Remove existing damaged sealant ... to stop water ingress at:
 *   a. Level 1 entrance's window frame
 *   b. Level 2 meeting room's window frame and sill
 *
 * The export wraps on newlines already, so each place lands on its own row.
 * Below two places there is nothing to group, and the model has written the
 * location into the description as it always did.
 */
export function applyGroupedLocations(items) {
    for (const item of items) {
        const places = (item.locations ?? []).map((l) => String(l).trim()).filter(Boolean);
        if (places.length < 2) {
            delete item.locations;
            continue;
        }
        const lead = item.description.trim().replace(/[:.\s]+$/, "");
        item.description = [
            `${lead} at:`,
            ...places.map((place, i) => `${locationMarker(i)}. ${place.replace(/[.\s]+$/, "")}`),
        ].join("\n");
        item.locations = places;
    }
}
