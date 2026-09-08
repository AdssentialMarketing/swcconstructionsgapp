import bcrypt from "bcrypt";
import { pool } from "./pool.js";
// Usage: tsx src/db/seedUser.ts "Full Name" email@example.com password123
async function seedUser() {
    const [name, email, password] = process.argv.slice(2);
    if (!name || !email || !password) {
        console.error('Usage: npm run seed:user --workspace server -- "Full Name" email@example.com password123');
        process.exit(1);
    }
    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(`INSERT INTO users (name, email, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash
     RETURNING id, name, email`, [name, email, password_hash]);
    console.log("User ready:", result.rows[0]);
    await pool.end();
}
seedUser().catch((err) => {
    console.error("Seeding failed:", err);
    process.exit(1);
});
