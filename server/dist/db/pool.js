import pg from "pg";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Explicit path, not the "dotenv/config" auto-loader: npm workspace scripts
// run with cwd set to server/, not the repo root where .env actually lives,
// so cwd-relative lookup silently finds nothing.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
const { Pool } = pg;
if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}
export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});
