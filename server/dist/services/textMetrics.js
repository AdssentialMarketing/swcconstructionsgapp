/**
 * Measuring text the way Excel lays it out.
 *
 * The templates wrap descriptions by hand — one worksheet row per visual
 * line — rather than relying on wrapText, which is what keeps every row the
 * same height. Reproducing that means deciding where to break, and character
 * counts are a poor proxy in a proportional font: an all-caps line of 78
 * characters is far wider than a lowercase one.
 *
 * So lines are measured in pixels against the real Calibri metrics below,
 * read straight out of Calibri.ttf rather than estimated. An earlier
 * hand-guessed table was about 25% narrow, which is what let a line overflow
 * the description column.
 *
 * Shared by both templates because they use the same font at different
 * sizes: the quotation at 11pt in a 494px column, the invoice at 9pt in a
 * 467px one.
 */
// Advance widths for Calibri (the template's font), in 1/2048 em units,
// read straight out of Calibri.ttf rather than estimated — an earlier
// hand-guessed table was ~25% narrow, which is what let a line overflow the
// Description column.
const CALIBRI_ADVANCE = {
    " ": 463, "!": 667, '"': 821, "#": 1020, $: 1038, "%": 1464, "&": 1397, "'": 452,
    "(": 621, ")": 621, "*": 1020, "+": 1020, ",": 511, "-": 627, ".": 517, "/": 791,
    "0": 1038, "1": 1038, "2": 1038, "3": 1038, "4": 1038, "5": 1038, "6": 1038, "7": 1038,
    "8": 1038, "9": 1038, ":": 548, ";": 548, "<": 1020, "=": 1020, ">": 1020, "?": 949,
    "@": 1831, A: 1185, B: 1114, C: 1092, D: 1260, E: 1000, F: 941, G: 1292,
    H: 1276, I: 516, J: 653, K: 1064, L: 861, M: 1751, N: 1322, O: 1356,
    P: 1058, Q: 1378, R: 1112, S: 941, T: 998, U: 1314, V: 1162, W: 1822,
    X: 1063, Y: 998, Z: 959, "[": 628, "\\": 791, "]": 628, "^": 1020, _: 1020,
    "`": 596, a: 981, b: 1076, c: 866, d: 1076, e: 1019, f: 625, g: 964,
    h: 1076, i: 470, j: 490, k: 931, l: 470, m: 1636, n: 1076, o: 1080,
    p: 1076, q: 1076, r: 714, s: 801, t: 686, u: 1076, v: 925, w: 1464,
    x: 887, y: 927, z: 809, "{": 644, "|": 943, "}": 644, "~": 1020, "‘": 511,
    "’": 511, "“": 857, "”": 857, "–": 1020, "—": 1854, "°": 694, "²": 688, "³": 685,
    "×": 1020, "±": 1020, "€": 1038, "£": 1038, "©": 1709, "®": 1038, "…": 1414,
};
const CALIBRI_UNITS_PER_EM = 2048;
// Anything not in the table (an accented letter, say) is charged the width of
// a lowercase "n", close to Calibri's average and erring on wrapping early.
const FALLBACK_ADVANCE = CALIBRI_ADVANCE.n;
/** Width of a string in pixels, at the given point size and 96 DPI. */
export function textWidthPx(text, fontPt) {
    const pxPerEm = (fontPt * 96) / 72;
    let units = 0;
    for (const ch of text)
        units += CALIBRI_ADVANCE[ch] ?? FALLBACK_ADVANCE;
    return (units * pxPerEm) / CALIBRI_UNITS_PER_EM;
}
/**
 * Builds a wrapper for one column: greedy word wrap at a pixel budget,
 * matching how the sample documents are laid out.
 */
export function makeDescriptionWrapper(maxLinePx, fontPt) {
    const fits = (text) => textWidthPx(text, fontPt) <= maxLinePx;
    return function wrapDescription(description) {
        const lines = [];
        for (const paragraph of String(description).split("\n")) {
            const words = paragraph.trim().split(/\s+/).filter(Boolean);
            if (words.length === 0) {
                lines.push("");
                continue;
            }
            let line = "";
            for (const word of words) {
                if (line === "") {
                    line = word;
                }
                else if (fits(`${line} ${word}`)) {
                    line = `${line} ${word}`;
                }
                else {
                    lines.push(line);
                    line = word;
                }
                // A single word wider than the column (a long URL, say) still has to
                // be broken, or it would silently overflow into the next column.
                while (!fits(line)) {
                    let cut = line.length - 1;
                    while (cut > 1 && !fits(line.slice(0, cut)))
                        cut--;
                    lines.push(line.slice(0, cut));
                    line = line.slice(cut);
                }
            }
            if (line !== "")
                lines.push(line);
        }
        return lines.length > 0 ? lines : [""];
    };
}
