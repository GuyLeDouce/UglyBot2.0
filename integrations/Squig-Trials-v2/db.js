import pg from 'pg';
import { CONFIG } from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: CONFIG.databaseUrl,
  ssl: { rejectUnauthorized: false }
});

export async function q(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}
