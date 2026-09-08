import bcrypt from "bcrypt";
import { pool } from "../db/pool.js";
const h = async (p) => bcrypt.hash(p, 10);
const acc = await pool.query(`INSERT INTO users (email,name,password_hash,role,initials)
  VALUES ('tmp-acc@example.invalid','Ada Accounts',$1,'accounts','AA') RETURNING id, role`, [await h("tmp-acc")]);
const sales = await pool.query(`INSERT INTO users (email,name,password_hash,role,initials)
  VALUES ('tmp-sal@example.invalid','Sam Sales',$1,'user','SL') RETURNING id, role`, [await h("tmp-sal")]);
console.log(JSON.stringify({ accounts: acc.rows[0], sales: sales.rows[0] }));
await pool.end();
