// The two line items that bracket a quotation's real scope of work.
//
// They differ in how firmly they are held, which mirrors how the six files
// in samples/ actually use them:
//
//   * the protection/safety item opens ALL six  -> a hard rule, re-applied
//     at export so it holds even if it is deleted while editing
//   * the paintwork item closes three of six    -> a default, added when the
//     draft is created and freely removable afterwards
//
// So only the first is enforced at export. Re-adding the paintwork item
// there would make the salesperson's decision to remove it impossible to
// carry out.
export const MANDATORY_FIRST_ITEM_DESCRIPTION = "Provide all necessary protection and safety measures prior to commencement of works and dispose debris";
export const DEFAULT_LAST_ITEM_DESCRIPTION = "Make good damaged paintworks with putty compound and close matching paint colour (localized areas only)";
const normalise = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const MANDATORY_PREFIX = normalise("Provide all necessary protection and safety measures");
const PAINTWORK_PREFIX = normalise("Make good damaged paintworks with putty compound");
/**
 * Recognises the standing protection/safety item.
 *
 * Deliberately matches on a prefix of the normalised text so a reworded or
 * differently punctuated copy is treated as the same item and moved into
 * place, rather than being left alone and a duplicate inserted above it.
 */
export function isMandatoryFirstItem(description) {
    return normalise(description).startsWith(MANDATORY_PREFIX);
}
/** Recognises the standard closing paintwork item, on the same prefix basis. */
export function isDefaultLastItem(description) {
    return normalise(description).startsWith(PAINTWORK_PREFIX);
}
function reposition(items, matches, create, position) {
    const list = Array.isArray(items) ? items : [];
    const targetIndex = position === "first" ? 0 : list.length - 1;
    const existing = list.findIndex((item) => matches(item.description ?? ""));
    if (existing === targetIndex && existing !== -1)
        return list;
    if (existing > -1) {
        // Present but in the wrong place — move it, keeping any price already set.
        const moved = [...list];
        const [item] = moved.splice(existing, 1);
        return position === "first" ? [item, ...moved] : [...moved, item];
    }
    return position === "first" ? [create(), ...list] : [...list, create()];
}
/**
 * Guarantees the protection/safety item leads the list, without duplicating
 * it and without discarding a price already set on it.
 *
 * `create` builds the item when one has to be added, so callers can supply
 * whatever extra fields their own line item shape requires.
 */
export function withMandatoryFirstItem(items, create) {
    return reposition(items, isMandatoryFirstItem, create, "first");
}
/**
 * Puts the standard paintwork item last on a freshly drafted quotation.
 *
 * Only for drafting: once the salesperson has a draft in front of them, its
 * absence means they removed it deliberately.
 */
export function withDefaultLastItem(items, create) {
    return reposition(items, isDefaultLastItem, create, "last");
}
/**
 * Keeps the paintwork item at the bottom if it is there, without ever
 * adding one that isn't.
 *
 * Making good the paintwork is the last thing done on site, so it reads
 * wrong anywhere but the final line — and a line item added after it in the
 * editor would otherwise push it up. Separate from withDefaultLastItem so
 * the export can guarantee the ordering without also resurrecting an item
 * the salesperson deleted.
 */
export function moveDefaultLastItemToEnd(items) {
    const list = Array.isArray(items) ? items : [];
    const existing = list.findIndex((item) => isDefaultLastItem(item.description ?? ""));
    if (existing === -1 || existing === list.length - 1)
        return list;
    const moved = [...list];
    const [item] = moved.splice(existing, 1);
    return [...moved, item];
}
