import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { JPEG_QUALITY, MAX_IMAGE_EDGE_PX } from "./imageStorage.js";
import { readFileSync } from "node:fs";
import { listLeakTypes, listRepairMethods, resolveLeakType, resolveMethods, } from "./leakTypes.js";
import { selectTeachingSet } from "./teachingSet.js";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-5";
const MIME_MAP = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
};
function mediaTypeFor(filePath, fallback) {
    const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    return MIME_MAP[ext] ?? (fallback || "image/jpeg");
}
// Photos are stored already normalised to these dimensions, so for anything
// uploaded since that changed this resize is a no-op pass. It stays because
// the teaching set still holds images imported before then, and because a
// file that somehow escaped normalisation must not blow the request limit —
// ten 10MB uploads plus the example images came back 413 before any of this.
async function imageBlock(filePath, _fallbackMime) {
    let data;
    try {
        const resized = await sharp(filePath)
            .rotate() // honour EXIF orientation, which is lost once re-encoded
            .resize({ width: MAX_IMAGE_EDGE_PX, height: MAX_IMAGE_EDGE_PX, fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: JPEG_QUALITY })
            .toBuffer();
        data = resized.toString("base64");
    }
    catch {
        // Unreadable by sharp (an odd format, a truncated file) — fall back to
        // the original bytes rather than dropping the photo entirely.
        return {
            type: "image",
            source: { type: "base64", media_type: mediaTypeFor(filePath, _fallbackMime), data: readFileSync(filePath).toString("base64") },
        };
    }
    return { type: "image", source: { type: "base64", media_type: "image/jpeg", data } };
}
function buildSystemPrompt(vocabulary, methods) {
    const vocabularyBlock = vocabulary
        .map((type) => {
        const lines = [`- "${type.name}"`];
        if (type.description)
            lines.push(`    looks like: ${type.description}`);
        if (type.typical_cause)
            lines.push(`    typical cause: ${type.typical_cause}`);
        if (type.typical_repair)
            lines.push(`    typical repair: ${type.typical_repair}`);
        return lines.join("\n");
    })
        .join("\n");
    // Grouped by diagnosis, because that is how the model has to use it: once
    // it has decided what the defect is, these are the ways this company fixes
    // that defect.
    const byLeakType = new Map();
    for (const m of methods) {
        if (!byLeakType.has(m.leak_type))
            byLeakType.set(m.leak_type, []);
        byLeakType.get(m.leak_type).push(m);
    }
    const methodBlock = [...byLeakType.entries()]
        .map(([leakType, options]) => {
        const lines = [`- for "${leakType}":`];
        for (const o of options) {
            lines.push(`    * "${o.method}" (${o.is_invasive ? "invasive" : "non-invasive"})`);
            if (o.description)
                lines.push(`        ${o.description}`);
            if (o.suitable_when)
                lines.push(`        suits: ${o.suitable_when}`);
            if (o.not_suitable_when)
                lines.push(`        avoid when: ${o.not_suitable_when}`);
        }
        return lines.join("\n");
    })
        .join("\n");
    return `You are assisting a Singapore waterproofing and leakage repair company's sales team.
You will be shown one or more site inspection photos from a single job, and may be shown labelled
example photos from past jobs first.

CLASSIFICATION VOCABULARY — "leak_type" MUST be exactly one of these strings, copied character for
character. Do not invent a new label, do not pluralise, do not add words:

${vocabularyBlock}

How to work:
- The photos are all from ONE job. Read them together: several may show the same defect from
  different angles, or one may show the damage while another shows its likely source. Do not treat
  them as unrelated cases.
- Use the reported issue and site details given to you. A photo often shows only a location — a
  doorway, a stretch of ceiling — with no clearly visible damage. In that case the reported symptom
  is the main evidence and you should say so plainly rather than guessing at a defect you cannot see.
- Choose the type that matches the underlying defect to be repaired, not the most visually obvious
  symptom. Staining on a ceiling under an awning bolt is a "roof leak", not a generic damp patch.
- Only use "other" when the photo genuinely does not fit any listed type.
- Be honest in "confidence". A low score on a photo that cannot support a diagnosis is more useful
  to the team than a confident guess, because it tells them to go back and look.

REPAIR METHODS — how this company fixes each defect. "method" MUST be exactly one of these strings:

${methodBlock}

About repair methods, and this matters:
- A photo tells you WHAT IS WRONG. It does not tell you WHICH REPAIR the customer wants. Those are
  different questions and you are being asked both separately.
- Where more than one method is listed for the diagnosis you chose, offer ALL of them that would
  genuinely work on this defect, best-first. Do not pick one and hide the others.
- The usual choice is between breaking up finishes and not. A customer with a newly renovated toilet
  may well prefer PU grouting over hacking; another may be re-tiling anyway and prefer hacking. Both
  are correct work. Your job is to say which are workable and why, not to decide for them.
- Only offer one method when the others genuinely would not fix this defect — and say so in the
  rationale.
- "suggested_repair_approach" should describe your FIRST option, so it still reads as one answer.

Respond with ONLY a JSON object (no markdown fences, no prose):

{
  "photos": [
    {
      "index": number,                     // 1-based, matching the labels on the photos below
      "leak_type": string,                 // EXACTLY one of the vocabulary strings above
      "severity": "minor" | "moderate" | "severe",
      "cause": string,                     // likely root cause, 1-2 sentences
      "location_notes": string,            // where on the structure this is
      "suggested_repair_approach": string, // brief, 1-2 sentences, describing repair_options[0]
      "repair_options": [                  // every method that would work, best-first
        {
          "method": string,                // EXACTLY one of the method strings above
          "rationale": string,             // why this suits THIS photo, 1 sentence
          "is_invasive": boolean           // copy from the list above
        }
      ],
      "confidence": number                 // 0.0-1.0 for THIS photo
    }
  ],
  "primary_leak_type": string,             // the one defect this job is really about
  "overall_severity": "minor" | "moderate" | "severe",
  "summary": string                        // 1-3 sentences a salesperson could read aloud
}

Return one entry in "photos" for every photo given, in order.`;
}
async function exampleBlocks(selection) {
    const content = [];
    // Which cases carry their image is decided in selectTeachingSet, so the
    // Training page can show exactly what the model is being sent.
    const withImages = selection.chosen.filter((example) => selection.imageIds.has(example.id));
    const textOnly = selection.chosen.filter((example) => !selection.imageIds.has(example.id));
    if (withImages.length > 0) {
        content.push({
            type: "text",
            text: "LABELLED EXAMPLES from past jobs. These are the team's own confirmed classifications — match this judgement:",
        });
        for (const example of withImages) {
            try {
                content.push(await imageBlock(example.image_path));
            }
            catch {
                continue; // image file missing — fall back to its labels alone
            }
            content.push({
                type: "text",
                text: [
                    `leak_type: ${example.leak_type}`,
                    example.severity ? `severity: ${example.severity}` : null,
                    example.cause ? `cause: ${example.cause}` : null,
                    example.location_notes ? `location: ${example.location_notes}` : null,
                    example.repair_approach ? `repair: ${example.repair_approach}` : null,
                    example.notes ? `note to you: ${example.notes}` : null,
                ]
                    .filter(Boolean)
                    .join("\n"),
            });
        }
    }
    if (textOnly.length > 0) {
        content.push({
            type: "text",
            text: "FURTHER CONFIRMED CASES (labels only, no image):\n" +
                textOnly
                    .map((example) => [
                    `- ${example.leak_type}${example.severity ? ` (${example.severity})` : ""}`,
                    example.cause ? `  cause: ${example.cause}` : null,
                    example.notes ? `  note: ${example.notes}` : null,
                ]
                    .filter(Boolean)
                    .join("\n"))
                    .join("\n"),
        });
    }
    return content;
}
/**
 * Analyses every photo of an inspection in a single call.
 *
 * Previously each photo went out on its own with no context, which made
 * several angles of one defect come back as several unrelated findings and
 * left the model guessing at photos that only show a location.
 */
export async function analyzeInspectionPhotos(photos, context = {}) {
    if (photos.length === 0) {
        throw new Error("No photos given to analyse.");
    }
    const [vocabulary, methods, teaching] = await Promise.all([
        listLeakTypes(),
        listRepairMethods(),
        selectTeachingSet(),
    ]);
    if (vocabulary.length === 0) {
        throw new Error("No leak types are configured. Run `npm run seed:leaktypes --workspace server` or add them in the app before analysing photos.");
    }
    const content = [...(await exampleBlocks(teaching))];
    const contextLines = [
        context.siteAddress ? `Site: ${context.siteAddress}` : null,
        context.areaName ? `Area of the site these photos are from: ${context.areaName}` : null,
        context.reportedIssue
            ? `Reported issue (what the customer told us): ${context.reportedIssue}`
            : "Reported issue: not recorded — judge from the photos alone and keep confidence low where they do not show enough.",
    ].filter(Boolean);
    content.push({ type: "text", text: `THIS JOB\n${contextLines.join("\n")}` });
    content.push({
        type: "text",
        text: context.areaName
            ? `Here are the ${photos.length} photo(s) of ${context.areaName}, in order:`
            : `Here are the ${photos.length} photo(s) for this job, in order:`,
    });
    for (const [i, photo] of photos.entries()) {
        content.push({ type: "text", text: `Photo ${i + 1}:` });
        content.push(await imageBlock(photo.filePath, photo.mimeType));
    }
    content.push({
        type: "text",
        text: "Analyse these photos together and return the JSON object described in your instructions.",
    });
    const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: buildSystemPrompt(vocabulary, methods),
        messages: [{ role: "user", content }],
    });
    const textBlock = response.content.find((block) => block.type === "text");
    const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
    if (response.stop_reason === "max_tokens") {
        throw new Error("The photo analysis was cut off before finishing (hit the output token limit) — try again with fewer photos at once.");
    }
    let parsed;
    try {
        parsed = JSON.parse(extractJson(raw));
    }
    catch {
        throw new Error(`Claude vision response was not valid JSON: ${raw.slice(0, 500)}`);
    }
    const byIndex = new Map();
    for (const [i, entry] of (parsed.photos ?? []).entries()) {
        byIndex.set(typeof entry.index === "number" ? entry.index : i + 1, entry);
    }
    const analyses = photos.map((_, i) => {
        const entry = byIndex.get(i + 1) ?? {};
        const { leakType, matched } = resolveLeakType(entry.leak_type, vocabulary);
        return {
            leak_type: leakType,
            severity: entry.severity ?? "minor",
            cause: entry.cause ?? "",
            location_notes: entry.location_notes ?? "",
            suggested_repair_approach: entry.suggested_repair_approach ?? "",
            repair_options: resolveMethods(entry.repair_options, methods, leakType),
            // An answer that fell outside the vocabulary is not trustworthy enough
            // to drive pricing retrieval, so it is capped low to surface it for
            // correction rather than being presented as a confident result.
            confidence: matched ? Number(entry.confidence ?? 0) : Math.min(Number(entry.confidence ?? 0), 0.2),
            raw_model_response: raw,
        };
    });
    const primary = resolveLeakType(parsed.primary_leak_type, vocabulary);
    return {
        photos: analyses,
        primaryLeakType: primary.leakType,
        overallSeverity: parsed.overall_severity ?? "minor",
        summary: parsed.summary ?? "",
    };
}
/** Single-photo convenience wrapper, used when re-analysing one photo. */
export async function analyzePhoto(filePath, mimeType, context = {}) {
    const result = await analyzeInspectionPhotos([{ filePath, mimeType }], context);
    return result.photos[0];
}
// Strips markdown code fences if the model wraps the JSON despite instructions.
function extractJson(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    return fenced ? fenced[1].trim() : text.trim();
}
