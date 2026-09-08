import { pool } from "../db/pool.js";
/**
 * Records an archive, restore, exclusion change or deletion.
 *
 * The actor's name and a label for the record are written into the row
 * rather than joined at read time: an audit trail has to stay readable after
 * the thing it describes is gone, and deletion is one of the actions it
 * records. Joining would leave every delete entry pointing at nothing.
 *
 * Accepts a transaction client so an entry can be written inside the same
 * transaction as the change it describes — otherwise a rollback would leave
 * a log of something that never happened.
 */
export async function recordAudit(entry, client) {
    const db = client ?? pool;
    const { rows } = await db.query("SELECT name FROM users WHERE id = $1", [entry.actorId ?? null]);
    const actorName = rows[0]?.name ?? "(unknown)";
    await db.query(`INSERT INTO audit_log (actor_id, actor_name, action, entity_type, entity_id, entity_label, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
        entry.actorId ?? null,
        actorName,
        entry.action,
        entry.entityType,
        entry.entityId,
        entry.entityLabel,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
    ]);
}
export async function listAudit(limit = 200, entityType) {
    const { rows } = await pool.query(`SELECT id, actor_id, actor_name, action, entity_type, entity_id, entity_label, detail, created_at
     FROM audit_log
     WHERE $1::text IS NULL OR entity_type = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`, [entityType ?? null, limit]);
    return rows;
}
