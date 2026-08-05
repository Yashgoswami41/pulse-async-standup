import 'dotenv/config';
import postgres from 'postgres';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Add it to your .env file.');
}

export const sql = postgres(connectionString, {
  ssl: 'require',
  connect_timeout: 10,
  idle_timeout: 20,
  max: 5,
});
