import express from "express";
import cors from "cors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import path from "node:path";
import { existsSync } from "node:fs";
import { pool } from "./db/pool.js";
import { requireAuth } from "./middleware/auth.js";
import { serveProtectedFiles } from "./middleware/protectedFiles.js";
import { authRouter } from "./routes/auth.js";
import { inspectionsRouter } from "./routes/inspections.js";
import { photosRouter } from "./routes/photos.js";
import { quotationsRouter } from "./routes/quotations.js";
import { libraryRouter } from "./routes/library.js";
import { trainingRouter } from "./routes/training.js";
import { pricingRouter } from "./routes/pricing.js";
import { repairMethodsRouter } from "./routes/repairMethods.js";
import { invoicesRouter } from "./routes/invoices.js";
import { areasRouter } from "./routes/areas.js";
import { accountRouter } from "./routes/account.js";
import { usersRouter } from "./routes/users.js";
import { reviewsRouter } from "./routes/reviews.js";
import { allQuotationsRouter } from "./routes/allQuotations.js";
import { lifecycleRouter } from "./routes/lifecycle.js";
const app = express();
const PgSession = connectPgSimple(session);
const isProduction = process.env.NODE_ENV === "production";
// A predictable signing secret makes every session forgeable, so a
// production boot without one is a failure rather than a silent default.
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret && isProduction) {
    throw new Error("SESSION_SECRET must be set in production — refusing to start with a default secret.");
}
// Behind nginx/Apache the app sees the proxy's address, so it needs to be
// told to trust the forwarded headers or secure cookies are never set and
// the rate limiter buckets every request under one IP.
if (isProduction)
    app.set("trust proxy", 1);
app.use(cors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:5173", credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(session({
    store: new PgSession({ pool, createTableIfMissing: true }),
    secret: sessionSecret ?? "dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "lax",
        // Over HTTPS the cookie must never be sent in clear.
        secure: isProduction,
        maxAge: 1000 * 60 * 60 * 24 * 7,
    },
}));
// Client photos, quotations and signatures. Each request is checked against
// the job it belongs to — being signed in is not enough, because the
// filenames are guessable. See protectedFiles.ts.
app.use("/uploads", serveProtectedFiles("uploads"));
app.use("/exports", serveProtectedFiles("exports"));
app.use("/signatures", serveProtectedFiles("signatures"));
app.use("/api/auth", authRouter);
app.use("/api/inspections", requireAuth, inspectionsRouter);
app.use("/api", requireAuth, photosRouter);
app.use("/api", requireAuth, quotationsRouter);
app.use("/api", requireAuth, libraryRouter);
// The admin check lives on the individual routes in these routers, not on
// the mount: middleware given to app.use runs for every request that reaches
// that line, so gating here would also have blocked the routers mounted
// below it (it did — /api/account and /api/areas started returning 403).
app.use("/api", requireAuth, trainingRouter);
app.use("/api", requireAuth, areasRouter);
app.use("/api", requireAuth, accountRouter);
app.use("/api", requireAuth, usersRouter);
app.use("/api", requireAuth, reviewsRouter);
app.use("/api", requireAuth, allQuotationsRouter);
app.use("/api", requireAuth, lifecycleRouter);
app.use("/api", requireAuth, pricingRouter);
app.use("/api", requireAuth, repairMethodsRouter);
app.use("/api", requireAuth, invoicesRouter);
// The built front end, so production is a single process to run and there
// is no separate web server to keep in step. Registered after the API so a
// route like /api/... is never swallowed by the catch-all below.
const webDist = path.resolve(process.cwd(), "..", "web", "dist");
if (existsSync(webDist)) {
    app.use(express.static(webDist));
    // Client-side routing: anything that is not an API call or a real file is
    // the single-page app, which resolves the path itself.
    app.get(/^(?!\/api\/).*/, (req, res, next) => {
        if (req.method !== "GET")
            return next();
        res.sendFile(path.join(webDist, "index.html"));
    });
    console.log(`Serving the web build from ${webDist}`);
}
app.use((err, _req, res, _next) => {
    console.error(err);
    const message = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json({ error: message });
});
const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
    console.log(`Server listening on port ${port} (${isProduction ? "production" : "development"})`);
});
