import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Missing DATABASE_URL');

  console.log('🧾 MIGRATE START');
  console.log('🧾 NODE_ENV:', process.env.NODE_ENV || '(not set)');
  console.log('🧾 RAILWAY_ENVIRONMENT:', process.env.RAILWAY_ENVIRONMENT || '(not set)');
  console.log('🧾 DATABASE_URL set:', databaseUrl ? 'YES' : 'NO');
  console.log('🧭 DB host:', new URL(databaseUrl).hostname);

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('railway') ? { rejectUnauthorized: false } : undefined
  });

  try {
    const sqlDir = path.join(__dirname, 'sql');
    const files = fs
      .readdirSync(sqlDir)
      .filter(f => /^\d+_.+\.sql$/.test(f))
      .sort((a, b) => a.localeCompare(b, 'en'));

    console.log('🧱 Found migrations:', files.join(', '));

    for (const f of files) {
      const full = path.join(sqlDir, f);
      const sql = fs.readFileSync(full, 'utf8');
      await pool.query(sql);
      console.log('✅ Applied migration:', f);
    }

    const check = await pool.query(
      "SELECT " +
      "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='trials' AND column_name='points_min') AS has_points_min, " +
      "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='trials' AND column_name='points_max') AS has_points_max"
    );

    console.log('🔎 Schema check:', check.rows[0]);
    console.log('✅ Migration complete (Railway Postgres)');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
