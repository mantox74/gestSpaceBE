const { Pool } = require('pg');
require('dotenv').config();

// Forza PostgreSQL a trattare le date come UTC
const { types } = require('pg');
types.setTypeParser(1082, (val) => val); // date → stringa pura YYYY-MM-DD
types.setTypeParser(1114, (val) => val); // timestamp → stringa pura
types.setTypeParser(1184, (val) => val); // timestamptz → stringa pura

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('connect', (client) => {
  client.query("SET timezone = 'Europe/Rome'");
  console.log('Connesso al database gestSpace');
});

pool.on('error', (err) => {
  console.error('Errore connessione database:', err);
  process.exit(-1);
});

module.exports = pool;