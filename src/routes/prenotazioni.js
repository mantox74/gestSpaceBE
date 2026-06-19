const express = require('express');
const router = express.Router();
const pool = require('../db');
const auth = require('../middleware/auth');

// Funzione helper: controlla sovrapposizioni
async function controllaSovrapposizione(spazioId, dataInizio, dataFine, escludiId = null) {
  const query = escludiId
    ? `SELECT id FROM prenotazioni
       WHERE spazio_id = $1
         AND stato NOT IN ('ANNULLATA', 'CONCLUSA')
         AND id != $4
         AND (data_inizio, data_fine) OVERLAPS ($2::timestamp, $3::timestamp)`
    : `SELECT id FROM prenotazioni
       WHERE spazio_id = $1
         AND stato NOT IN ('ANNULLATA', 'CONCLUSA')
         AND (data_inizio, data_fine) OVERLAPS ($2::timestamp, $3::timestamp)`;

  const params = escludiId
    ? [spazioId, dataInizio, dataFine, escludiId]
    : [spazioId, dataInizio, dataFine];

  const result = await pool.query(query, params);
  return result.rows.length > 0;
}

// GET /api/prenotazioni - lista tutte le prenotazioni
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*,
              c.nome AS cliente_nome, c.cognome AS cliente_cognome,
              c.email AS cliente_email, c.telefono AS cliente_telefono,
              s.nome AS spazio_nome, s.prezzo_giorno
       FROM prenotazioni p
       JOIN clienti c ON p.cliente_id = c.id
       JOIN spazi s ON p.spazio_id = s.id
       ORDER BY p.data_inizio DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// GET /api/prenotazioni/calendario - per il calendario (pubblico o autenticato)
router.get('/calendario', auth, async (req, res) => {
  const { da, a } = req.query;
  try {
    const result = await pool.query(
      `SELECT p.id, p.data_inizio, p.data_fine, p.stato,
              c.nome AS cliente_nome, c.cognome AS cliente_cognome,
              s.nome AS spazio_nome, s.id AS spazio_id
       FROM prenotazioni p
       JOIN clienti c ON p.cliente_id = c.id
       JOIN spazi s ON p.spazio_id = s.id
       WHERE p.stato NOT IN ('ANNULLATA')
         AND ($1::date IS NULL OR p.data_fine >= $1::date)
         AND ($2::date IS NULL OR p.data_inizio <= $2::date)
       ORDER BY p.data_inizio ASC`,
      [da || null, a || null]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// GET /api/prenotazioni/calendario/pubblico - senza autenticazione per sito esterno
router.get('/calendario/pubblico', async (req, res) => {
  const { da, a } = req.query;
  try {
    const result = await pool.query(
      `SELECT p.data_inizio, p.data_fine,
              s.nome AS spazio_nome, s.id AS spazio_id
       FROM prenotazioni p
       JOIN spazi s ON p.spazio_id = s.id
       WHERE p.stato NOT IN ('ANNULLATA')
         AND ($1::date IS NULL OR p.data_fine >= $1::date)
         AND ($2::date IS NULL OR p.data_inizio <= $2::date)
       ORDER BY p.data_inizio ASC`,
      [da || null, a || null]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// GET /api/prenotazioni/:id - dettaglio singola prenotazione
router.get('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*,
              c.nome AS cliente_nome, c.cognome AS cliente_cognome,
              c.email AS cliente_email, c.telefono AS cliente_telefono,
              s.nome AS spazio_nome, s.prezzo_giorno
       FROM prenotazioni p
       JOIN clienti c ON p.cliente_id = c.id
       JOIN spazi s ON p.spazio_id = s.id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Prenotazione non trovata' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// POST /api/prenotazioni - crea nuova prenotazione
router.post('/', auth, async (req, res) => {
  const { cliente_id, spazio_id, data_inizio, data_fine, note, preventivo_id } = req.body;

  if (!cliente_id || !spazio_id || !data_inizio || !data_fine) {
    return res.status(400).json({ error: 'cliente_id, spazio_id, data_inizio e data_fine sono obbligatori' });
  }

  if (new Date(data_inizio) >= new Date(data_fine)) {
    return res.status(400).json({ error: 'La data di inizio deve essere precedente alla data di fine' });
  }

  try {
    // Controlla sovrapposizioni
    const sovrapposizione = await controllaSovrapposizione(spazio_id, data_inizio, data_fine);
    if (sovrapposizione) {
      return res.status(409).json({ error: 'Lo spazio non è disponibile nel periodo selezionato' });
    }

    const result = await pool.query(
      `INSERT INTO prenotazioni
        (cliente_id, spazio_id, data_inizio, data_fine, note, preventivo_id, modificato_da_id, data_ultima_modifica)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING *`,
      [cliente_id, spazio_id, data_inizio, data_fine, note, preventivo_id || null, req.utente.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// PUT /api/prenotazioni/:id - modifica prenotazione
router.put('/:id', auth, async (req, res) => {
  const { cliente_id, spazio_id, data_inizio, data_fine, stato, note } = req.body;

  try {
    // Recupera prenotazione esistente
    const esistente = await pool.query(
      'SELECT * FROM prenotazioni WHERE id = $1',
      [req.params.id]
    );
    if (esistente.rows.length === 0) {
      return res.status(404).json({ error: 'Prenotazione non trovata' });
    }

    const attuale = esistente.rows[0];
    const nuovoInizio = data_inizio || attuale.data_inizio;
    const nuovaFine = data_fine || attuale.data_fine;
    const nuovoSpazio = spazio_id || attuale.spazio_id;

    // Controlla sovrapposizioni escludendo la prenotazione corrente
    const sovrapposizione = await controllaSovrapposizione(
      nuovoSpazio, nuovoInizio, nuovaFine, req.params.id
    );
    if (sovrapposizione) {
      return res.status(409).json({ error: 'Lo spazio non è disponibile nel periodo selezionato' });
    }

    const result = await pool.query(
      `UPDATE prenotazioni
       SET cliente_id = COALESCE($1, cliente_id),
           spazio_id = COALESCE($2, spazio_id),
           data_inizio = COALESCE($3, data_inizio),
           data_fine = COALESCE($4, data_fine),
           stato = COALESCE($5, stato),
           note = COALESCE($6, note),
           modificato_da_id = $7,
           data_ultima_modifica = NOW()
       WHERE id = $8
       RETURNING *`,
      [cliente_id, spazio_id, data_inizio, data_fine, stato, note, req.utente.id, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// DELETE /api/prenotazioni/:id - annulla prenotazione
router.delete('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE prenotazioni
       SET stato = 'ANNULLATA',
           modificato_da_id = $1,
           data_ultima_modifica = NOW()
       WHERE id = $2
       RETURNING *`,
      [req.utente.id, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Prenotazione non trovata' });
    }
    res.json({ message: 'Prenotazione annullata', prenotazione: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

module.exports = router;