const express = require('express');
const router = express.Router();
const pool = require('../db');
const auth = require('../middleware/auth');

// Funzione helper: calcola importo fattura
async function calcolaImporto(prenotazioneId, dataInizio, dataFine) {
  const result = await pool.query(
    `SELECT s.prezzo_giorno
     FROM prenotazioni p
     JOIN spazi s ON p.spazio_id = s.id
     WHERE p.id = $1`,
    [prenotazioneId]
  );
  if (result.rows.length === 0) return null;

  const prezzoGiorno = parseFloat(result.rows[0].prezzo_giorno);
  const inizio = new Date(dataInizio);
  const fine = new Date(dataFine);
  const giorni = Math.ceil((fine - inizio) / (1000 * 60 * 60 * 24));
  return { prezzoGiorno, giorni, importo: prezzoGiorno * giorni };
}

// Funzione helper: genera numero fattura progressivo
async function generaNumeroFattura() {
  const anno = new Date().getFullYear();
  const result = await pool.query(
    `SELECT COUNT(*) FROM fatture WHERE EXTRACT(YEAR FROM data_emissione) = $1`,
    [anno]
  );
  const progressivo = parseInt(result.rows[0].count) + 1;
  return `${anno}-${String(progressivo).padStart(4, '0')}`;
}

// GET /api/fatture - lista tutte le fatture
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT f.*,
              c.nome AS cliente_nome, c.cognome AS cliente_cognome,
              c.email AS cliente_email,
              s.nome AS spazio_nome,
              p.data_inizio AS prenotazione_inizio,
              p.data_fine AS prenotazione_fine
       FROM fatture f
       JOIN prenotazioni p ON f.prenotazione_id = p.id
       JOIN clienti c ON p.cliente_id = c.id
       JOIN spazi s ON p.spazio_id = s.id
       ORDER BY f.data_emissione DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// GET /api/fatture/:id - dettaglio singola fattura
router.get('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT f.*,
              c.nome AS cliente_nome, c.cognome AS cliente_cognome,
              c.email AS cliente_email, c.telefono AS cliente_telefono,
              c.indirizzo AS cliente_indirizzo,
              c.codice_fiscale, c.p_iva,
              s.nome AS spazio_nome, s.prezzo_giorno,
              p.data_inizio AS prenotazione_inizio,
              p.data_fine AS prenotazione_fine
       FROM fatture f
       JOIN prenotazioni p ON f.prenotazione_id = p.id
       JOIN clienti c ON p.cliente_id = c.id
       JOIN spazi s ON p.spazio_id = s.id
       WHERE f.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Fattura non trovata' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// GET /api/fatture/prenotazione/:id - fatture di una prenotazione
router.get('/prenotazione/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT f.*
       FROM fatture f
       WHERE f.prenotazione_id = $1
       ORDER BY f.data_emissione ASC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// POST /api/fatture - crea nuova fattura
router.post('/', auth, async (req, res) => {
  const { prenotazione_id, tipo_emissione, frequenza_giorni, iva, data_inizio_periodo, data_fine_periodo } = req.body;

  if (!prenotazione_id || !tipo_emissione) {
    return res.status(400).json({ error: 'prenotazione_id e tipo_emissione sono obbligatori' });
  }

  if (tipo_emissione === 'PERIODICA' && !frequenza_giorni) {
    return res.status(400).json({ error: 'frequenza_giorni è obbligatorio per fatturazione periodica' });
  }

  try {
    // Recupera la prenotazione
    const prenotazione = await pool.query(
      'SELECT * FROM prenotazioni WHERE id = $1',
      [prenotazione_id]
    );
    if (prenotazione.rows.length === 0) {
      return res.status(404).json({ error: 'Prenotazione non trovata' });
    }

    const pren = prenotazione.rows[0];

    // Determina il periodo da fatturare
    const periodoInizio = data_inizio_periodo || pren.data_inizio;
    const periodoFine = data_fine_periodo || pren.data_fine;

    // Calcola importo
    const calcolo = await calcolaImporto(prenotazione_id, periodoInizio, periodoFine);
    if (!calcolo) {
      return res.status(500).json({ error: 'Errore nel calcolo dell\'importo' });
    }

    const ivaPerc = iva || 22;
    const numero = await generaNumeroFattura();

    const result = await pool.query(
      `INSERT INTO fatture
        (prenotazione_id, numero, importo, iva, tipo_emissione, frequenza_giorni)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        prenotazione_id,
        numero,
        calcolo.importo,
        ivaPerc,
        tipo_emissione,
        frequenza_giorni || null
      ]
    );

    res.status(201).json({
      ...result.rows[0],
      dettaglio: {
        giorni: calcolo.giorni,
        prezzo_giorno: calcolo.prezzoGiorno,
        importo_netto: calcolo.importo,
        importo_iva: (calcolo.importo * ivaPerc / 100).toFixed(2),
        importo_totale: (calcolo.importo * (1 + ivaPerc / 100)).toFixed(2)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// PUT /api/fatture/:id/stato - aggiorna stato pagamento
router.put('/:id/stato', auth, async (req, res) => {
  const { stato_pagamento } = req.body;

  if (!stato_pagamento) {
    return res.status(400).json({ error: 'stato_pagamento è obbligatorio' });
  }

  try {
    const result = await pool.query(
      `UPDATE fatture SET stato_pagamento = $1 WHERE id = $2 RETURNING *`,
      [stato_pagamento, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Fattura non trovata' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// DELETE /api/fatture/:id - elimina fattura
router.delete('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM fatture WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Fattura non trovata' });
    }
    res.json({ message: 'Fattura eliminata' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

module.exports = router;