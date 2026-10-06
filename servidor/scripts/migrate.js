require('dotenv').config({ quiet: true });

const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

const connectionString = String(process.env.DATABASE_URL || '').trim();

const pool = new Pool(
    connectionString
        ? {
            connectionString,
            ssl: { rejectUnauthorized: false },
            connectionTimeoutMillis: 10000
        }
        : {
            host: process.env.DB_HOST || 'localhost',
            port: Number(process.env.DB_PORT || 5432),
            database: process.env.DB_NAME || 'Runtrash',
            user: process.env.DB_USER || 'postgres',
            password: process.env.DB_PASSWORD || '',
            ssl: String(process.env.DB_SSL || '').toLowerCase() === 'true'
                ? { rejectUnauthorized: false }
                : undefined,
            connectionTimeoutMillis: 10000
        }
);

const migrationsDirectory = path.join(__dirname, '..', 'migrations');

async function migrate() {
    const client = await pool.connect();

    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                name VARCHAR(255) PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await client.query("SELECT pg_advisory_lock(hashtext('runtrash_schema_migrations'))");

        const files = (await fs.readdir(migrationsDirectory))
            .filter((file) => file.endsWith('.sql'))
            .sort((left, right) => left.localeCompare(right));

        const appliedResult = await client.query('SELECT name FROM schema_migrations');
        const applied = new Set(appliedResult.rows.map((row) => row.name));

        for (const file of files) {
            if (applied.has(file)) {
                console.log(`↷ ${file} ya estaba aplicada`);
                continue;
            }

            const sql = await fs.readFile(path.join(migrationsDirectory, file), 'utf8');
            await client.query('BEGIN');

            try {
                await client.query(sql);
                await client.query(
                    'INSERT INTO schema_migrations (name) VALUES ($1)',
                    [file]
                );
                await client.query('COMMIT');
                console.log(`✓ ${file}`);
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            }
        }
    } finally {
        try {
            await client.query("SELECT pg_advisory_unlock(hashtext('runtrash_schema_migrations'))");
        } finally {
            client.release();
        }
    }
}

migrate()
    .then(() => {
        console.log('Migraciones de PostgreSQL completadas.');
    })
    .catch((error) => {
        console.error('Error aplicando migraciones:', error.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
