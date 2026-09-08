import Anthropic from "@anthropic-ai/sdk";
import { applyGroupedLocations } from "./lineItemGrouping.js";
import { adjustmentFor, applyAdjustment, PROPERTY_TYPE_LABELS, } from "./pricingAdjustments.js";
import { findCommonTerms, findCommonTermsOverall, findSimilarQuotations, findStyleReferenceLineItems, getActiveBoilerplate, } from "./retrieval.js";
import { DEFAULT_LAST_ITEM_DESCRIPTION, MANDATORY_FIRST_ITEM_DESCRIPTION, withDefaultLastItem, withMandatoryFirstItem, } from "./standardLineItems.js";
import { normaliseScheduleOfWork, normaliseWarrantyText } from "./quotationTerms.js";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-5";
const SYSTEM_PROMPT = `You are drafting a repair quotation for a waterproofing/leakage repair company's sales team.
You will be given:
1. AI analysis of one or more site inspection photos (leak type, severity, cause, location, suggested repair).
2. A set of historical reference quotations for similar past cases (leak type, line items with their exact
   original wording, and final prices) — this is the ONLY source of truth for pricing. Never invent a price
   that isn't grounded in these references.
3. A set of example line-item descriptions pulled from past quotations for similar leak types. Match their
   phrasing style, terminology, level of detail, and structure when writing new line item descriptions —
   do not write generic boilerplate that doesn't sound like these examples.
4. Recurring boilerplate snippets (standard terms, exclusions, closing notes) that may be worth including.

Rules:
- If NO relevant historical reference is found for a leak type, do NOT invent a price. Instead, set
  "low_confidence": true, still propose a line item with your best description (in the general style of any
  other examples given), but set unit_price to 0 and say in "justification" that no pricing reference was
  found and the salesperson must set the price manually.
- If a good reference exists, propose a unit_price grounded in the referenced final_price / line item prices,
  and explain which reference(s) you used in "justification".
- Write line item descriptions in the phrasing style of the provided examples, not generic phrasing.
- If the job is broken into AREAS, produce exactly ONE repair line item per area, in the order given,
  and name the area in the description so the customer can tell the areas apart on the quotation. Do
  not merge two areas into one line item, and do not split one area across several. Price each area
  separately. (The standard opening and closing items below are additional to these, and are not tied
  to any area.)
- The FIRST line item of every quotation must always be, word for word:
  "Provide all necessary protection and safety measures prior to commencement of works and dispose debris"
  Give it unit_price 0 unless a historical reference prices it, and start the actual repair work at item 2.
- Where the works damage or disturb existing paintwork, the LAST line item should be, word for word:
  "Make good damaged paintworks with putty compound and close matching paint colour (localized areas only)"
  Give it unit_price 0 unless a historical reference prices it. The salesperson can remove it, so include it
  whenever making good is plausible rather than only when certain.
- Because that closing item already covers ALL reinstatement of finishes, never write a separate line item
  for making good, patching or redecorating after the repair. That means no line item for: repainting or
  paint touch-up, matching paint colour, putty or skim coat, plastering or plaster finishing, or making
  good walls and ceilings. Do not tack such wording onto the end of a repair line item either — a repair
  line stops at the point the leak is sealed.
  * The reference quotations you are shown DO contain such a line. That IS the standard closing item, not
    an extra one to copy alongside it.
  * The exception is breaking out or removing material in order to REACH the defect — hacking wall tiles
    to expose a leaking pipe, opening a screed to get at a joint. That is access work, it is part of the
    repair, and it belongs in that area's line item. Reinstating what was broken out is not.
  So write "Hack and remove existing wall tiles to trace and replace the leaking water supply pipe", not
  "... and patch up the hacked areas with new tiles and repaint".
- Always use "LS" (lump sum) as the "unit" — it is the only unit this company quotes in. Never write "lot",
  "Job", "each" or similar.
- You are given PAST SCHEDULE AND WARRANTY WORDINGS: what this company actually put on previous jobs of
  the same leak type, with a count of how often each was used. Suggest from these.
  * Default to the most frequently used wording for the leak type. That is what the team normally
    quotes, and matching it is almost always right.
  * Depart from it only when this job's scope clearly differs — more areas, or a much larger or
    smaller extent of work than the references — and say so in "notes". Scale the number of working
    days to the scope; do not scale the warranty, which reflects the type of work, not its size.
  * If there is no history at all for this leak type, use the overall most common wording rather than
    inventing a duration.
  * Only use JSON null if there is no history whatsoever to draw on.
  * Never write the bare word undefined (it is not valid JSON).
- Those two fields must be the COMPLETE sentence, worded exactly like the past ones, e.g.
  "1 working day(s) subjected to weather conditions" and "12 (TWELVE) months from date of invoice for
  area(s) of work against water leakage only". They are printed verbatim onto the quotation, so never
  answer with just the number ("1", "12") or an abbreviated form. If you change the duration, keep the
  rest of the sentence identical to the reference wording.
- Keep each "justification" to one or two sentences. It exists so the salesperson can see which
  reference informed a price, not to restate the reasoning at length.
- Respond with ONLY a JSON object (no markdown fences, no prose) matching this shape. Every field must be
  present — use JSON null for any field with nothing to report, never omit a key or write "undefined":

{
  "line_items": [
    {
      "description": string,
      "quantity": number,
      "unit": string,
      "unit_price": number,
      "total": number,
      "leak_type_tag": string,
      "justification": string
    }
  ],
  "notes": string,           // any recommended boilerplate/terms to include, or general remarks
  "low_confidence": boolean, // true if ANY line item lacked good pricing reference
  "reference_library_ids": number[], // ids of quotation_library rows you actually drew on
  "suggested_schedule_of_work": string or null,
  "suggested_warranty_text": string or null
}`;
/** One area of the site, with the assessments of its photos. */
/**
 * What makes two areas the same job: the same defect, fixed the same way.
 *
 * Both halves matter. Two toilets with the same seepage are only one line
 * item if the customer chose the same method for both — one PU grouted and
 * one hacked are different work at different prices.
 */
function areaScopeKey(area) {
    const first = area.analyses[0];
    if (!first)
        return "unknown";
    const method = first.chosen_method ??
        first.repair_options?.[0]?.method ??
        "unspecified method";
    return `${first.leak_type} / ${method}`;
}
export async function draftQuotation(analyses, areas = [], propertyType = null) {
    const referencesByLeakType = new Map();
    const styleExamplesByLeakType = new Map();
    for (const analysis of analyses) {
        if (!referencesByLeakType.has(analysis.leak_type)) {
            referencesByLeakType.set(analysis.leak_type, await findSimilarQuotations(analysis.leak_type, analysis.severity, 5, propertyType, analysis.chosen_method ?? null));
            styleExamplesByLeakType.set(analysis.leak_type, await findStyleReferenceLineItems(analysis.leak_type));
        }
    }
    const boilerplate = await getActiveBoilerplate();
    // What the team actually wrote on past jobs of these leak types, counted.
    // Falls back to the overall history so a leak type quoted for the first
    // time still gets the company's usual wording rather than an invention.
    const termsByLeakType = new Map();
    for (const leakType of referencesByLeakType.keys()) {
        termsByLeakType.set(leakType, await findCommonTerms(leakType));
    }
    const overallTerms = await findCommonTermsOverall();
    const referencePayload = Object.fromEntries(referencesByLeakType);
    const styleExamplePayload = Object.fromEntries(styleExamplesByLeakType);
    const userPrompt = `PHOTO ANALYSES:
${JSON.stringify(analyses, null, 2)}

THIS SITE'S PROPERTY TYPE: ${propertyType ? PROPERTY_TYPE_LABELS[propertyType] ?? propertyType : "not recorded"}

REPAIR METHOD ALREADY CHOSEN, per photo, under "chosen_method" in the analyses above.
Where a photo names one, the customer has settled on that method and you must write the scope of
work for THAT method only — do not quote the alternative, do not mention it, and do not hedge
between them. A photo showing "chosen_method": null has not been settled: quote the method in its
"repair_options"[0], which is the one this company reaches for first.
References marked with a matching "repair_method" are the ones priced for the same kind of work
and are the better guide; a reference for a different method shows the right wording but the
wrong price for this job.

HISTORICAL REFERENCE QUOTATIONS (grouped by leak type, for pricing).
Each reference carries the property type of the job it came from in "site_type".
References of the same property type as this site are listed first and are the
better guide to price; ones of another type still show the right scope and
wording. Do NOT try to convert prices between property types yourself — the
company applies its own rate afterwards.
${JSON.stringify(referencePayload, null, 2)}

STYLE REFERENCE LINE ITEMS (grouped by leak type, for phrasing — match this voice and structure):
${JSON.stringify(styleExamplePayload, null, 2)}

AVAILABLE BOILERPLATE SNIPPETS (offer to include if relevant):
${JSON.stringify(boilerplate, null, 2)}

PAST SCHEDULE AND WARRANTY WORDINGS (what was actually quoted before, and how often):
${JSON.stringify({
        by_leak_type: Object.fromEntries(termsByLeakType),
        across_all_past_jobs: overallTerms,
    }, null, 2)}
${areas.length > 0
        ? `
AREAS OF THIS SITE — the salesperson inspected ${areas.length} distinct area(s):

${areas
            .map((area, i) => `Area ${i + 1}: ${area.name ?? "(unnamed)"} [scope key: ${areaScopeKey(area)}]\n${JSON.stringify(area.analyses, null, 2)}`)
            .join("\n\n")}

GROUPING AREAS INTO LINE ITEMS — read this carefully, it decides how the quotation reads:
- Areas sharing the same "scope key" are the SAME work in different places. Quote them as ONE line
  item, not one per area. Two windows needing the same sealant replaced is one job.
- For a grouped item: write "description" as the scope of work with NO location in it, and put one
  short phrase per place in "locations", in the order the areas are listed. Do not write "at:", do
  not letter them, do not put the places in the description — that is assembled for you.
    description: "Remove existing damaged sealant, apply new UV-resistant waterproofing sealant to
                  the window frame-to-wall junction to stop water ingress"
    locations:   ["Level 1 entrance's window frame", "Level 2 meeting room's window frame and sill"]
- For an area with no other area sharing its scope key: write ONE item as before, naming the place
  inside the description ("... to Level 3 daughter bedroom balcony's wall and floor joints ..."),
  and omit "locations" entirely.
- Price a grouped item for ALL the places it covers, not for one of them.
- Keep the grouped items in the order the areas are listed.
`
        : ""}
Draft the quotation line items now, following the rules in your instructions.`;
    const response = await anthropic.messages.create({
        model: MODEL,
        // A multi-area draft writes a line item plus a justification per area on
        // top of the standard items; at 8192 a two-area job was truncated
        // mid-JSON and the whole draft was lost.
        max_tokens: 16384,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
    });
    const textBlock = response.content.find((block) => block.type === "text");
    const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
    if (response.stop_reason === "max_tokens") {
        throw new Error("The quotation draft was cut off before finishing (hit the output token limit) — try again with fewer areas or photos at once.");
    }
    let draft;
    try {
        draft = JSON.parse(extractJson(raw));
    }
    catch (err) {
        throw new Error(`Claude quotation draft response was not valid JSON (stop_reason: ${response.stop_reason}, ${raw.length} chars): ${raw.slice(0, 300)}`);
    }
    // Places first: the standard opening and closing items are not grouped,
    // and running this after them would have to skip over them.
    applyGroupedLocations(draft.line_items);
    // The export enforces this too, but doing it here as well means the
    // salesperson sees and can price the item in the editor rather than
    // having it appear for the first time in the finished Excel.
    draft.line_items = withMandatoryFirstItem(draft.line_items, () => ({
        description: MANDATORY_FIRST_ITEM_DESCRIPTION,
        quantity: 1,
        unit: "LS",
        unit_price: 0,
        total: 0,
        justification: "Standing company rule: every quotation opens with this protection and safety item.",
    }));
    // Added as a default rather than a rule — three of the six sample
    // quotations close with it, three don't — so the salesperson removes it
    // on the jobs where no making good is needed. The export deliberately
    // does not re-add it.
    draft.line_items = withDefaultLastItem(draft.line_items, () => ({
        description: DEFAULT_LAST_ITEM_DESCRIPTION,
        quantity: 1,
        unit: "LS",
        unit_price: 0,
        total: 0,
        justification: "Standard closing item on this company's quotations. Remove it if this job needs no making good of paintwork.",
    }));
    // These two go onto the quotation verbatim, next to a printed label
    // ("Schedule of work", "Warranty"), so a model that answers with just the
    // duration would show up on the customer's document as ": 1". Expanding
    // it here means the salesperson also sees the finished sentence in the
    // editor rather than a bare number.
    const firstLeakTypeTerms = termsByLeakType.values().next().value;
    const mostCommon = (pick) => pick(firstLeakTypeTerms ?? { schedule: [], warranty: [] })[0]?.value ?? pick(overallTerms)[0]?.value ?? null;
    // If the model declines to suggest but there IS history, fall back to the
    // most common past wording rather than leaving the line blank — an empty
    // schedule or warranty on a quotation is worse than the team's usual one,
    // and the salesperson can edit either.
    draft.suggested_schedule_of_work =
        normaliseScheduleOfWork(draft.suggested_schedule_of_work) ??
            normaliseScheduleOfWork(mostCommon((t) => t.schedule));
    draft.suggested_warranty_text =
        normaliseWarrantyText(draft.suggested_warranty_text) ?? normaliseWarrantyText(mostCommon((t) => t.warranty));
    // The company's own preferential rate, applied once, here. The model has
    // been told not to convert prices between property types itself, because
    // with a library this size it would be guessing the rate from one or two
    // examples. Done after the standard items are in place so the nil-priced
    // ones are left alone.
    draft.pricing_adjustment = await applyPricingAdjustment(draft, propertyType);
    return draft;
}
/**
 * Applies the property type's rate to every priced line in a draft.
 *
 * The rate can be set per leak type, so each line is looked up under its own
 * tag and falls back to the property type's default. Lines at nil are left
 * alone — they are the standing "INCL" items, and a percentage of nothing
 * would only turn INCL into $0.00 on the customer's document.
 */
async function applyPricingAdjustment(draft, propertyType) {
    if (!propertyType)
        return null;
    let adjusted = 0;
    let appliedPct = 0;
    for (const item of draft.line_items) {
        const pct = await adjustmentFor(propertyType, item.leak_type_tag ?? null);
        if (!pct || !item.unit_price)
            continue;
        item.unit_price = applyAdjustment(item.unit_price, pct);
        item.total = item.unit_price * (item.quantity || 1);
        adjusted += 1;
        appliedPct = pct;
    }
    if (adjusted === 0)
        return null;
    return {
        property_type: propertyType,
        property_type_label: PROPERTY_TYPE_LABELS[propertyType] ?? propertyType,
        adjustment_pct: appliedPct,
        lines_adjusted: adjusted,
    };
}
function extractJson(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonText = fenced ? fenced[1].trim() : text.trim();
    // `undefined` isn't valid JSON (only `null` is) — models occasionally
    // emit it anyway for an absent optional field despite prompt instructions
    // to the contrary. Normalize it rather than letting the whole draft fail.
    return jsonText.replace(/:\s*undefined\b/g, ": null");
}
