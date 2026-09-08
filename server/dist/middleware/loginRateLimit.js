/**
 * Throttles repeated failed logins.
 *
 * Counted per IP and per email separately: per-IP alone lets an attacker
 * spread guesses for one account across addresses, and per-email alone lets
 * one address work through a list of accounts. Only failures count, so
 * somebody signing in normally is never affected.
 *
 * In-process, so it resets on restart and does not span multiple instances.
 * That is enough for a single small deployment; a shared store would be the
 * next step if this ever runs on more than one process.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;
const buckets = new Map();
function check(key) {
    const now = Date.now();
    const entry = buckets.get(key);
    if (!entry || now - entry.firstAt > WINDOW_MS)
        return { blocked: false, retryAfterSeconds: 0 };
    if (entry.failures < MAX_FAILURES)
        return { blocked: false, retryAfterSeconds: 0 };
    return { blocked: true, retryAfterSeconds: Math.ceil((entry.firstAt + WINDOW_MS - now) / 1000) };
}
export function recordLoginFailure(req) {
    const now = Date.now();
    for (const key of keysFor(req)) {
        const entry = buckets.get(key);
        if (!entry || now - entry.firstAt > WINDOW_MS)
            buckets.set(key, { failures: 1, firstAt: now });
        else
            entry.failures += 1;
    }
}
export function clearLoginFailures(req) {
    for (const key of keysFor(req))
        buckets.delete(key);
}
function keysFor(req) {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const ip = req.ip ?? "unknown";
    return email ? [`ip:${ip}`, `email:${email}`] : [`ip:${ip}`];
}
export function loginRateLimit(req, res, next) {
    // Opportunistic cleanup, so the map cannot grow without bound.
    if (buckets.size > 5000) {
        const now = Date.now();
        for (const [key, entry] of buckets)
            if (now - entry.firstAt > WINDOW_MS)
                buckets.delete(key);
    }
    for (const key of keysFor(req)) {
        const { blocked, retryAfterSeconds } = check(key);
        if (blocked) {
            res.setHeader("Retry-After", String(retryAfterSeconds));
            return res.status(429).json({
                error: `Too many failed sign-in attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
            });
        }
    }
    next();
}
