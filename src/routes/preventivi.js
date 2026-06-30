const express = require('express');
const router = express.Router();
const pool = require('../db');
const auth = require('../middleware/auth');

const STATI_PREVENTIVO = Object.freeze({
  BOZZA: 'BOZZA',
  INVIATO: 'INVIATO',
  ACCETTATO: 'ACCETTATO',
  RIFIUTATO: 'RIFIUTATO',
  ANNULLATO: 'ANNULLATO',
});

const STATI_PREVENTIVO_VALUES = Object.values(STATI_PREVENTIVO);

// Funzione helper: calcola importo preventivo
function calcolaImporto(dataInizio, dataFine, prezzoGiorno) {
  const inizio = new Date(dataInizio);
  const fine = new Date(dataFine);
  const giorni = Math.ceil((fine - inizio) / (1000 * 60 * 60 * 24));
  return { giorni, importo: prezzoGiorno * giorni };
}

// GET /api/preventivi - lista tutti i preventivi
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pv.*,
              c.nome AS cliente_nome, c.cognome AS cliente_cognome,
              c.email AS cliente_email, c.telefono AS cliente_telefono,
              s.nome AS spazio_nome, s.prezzo_giorno
       FROM preventivi pv
       JOIN clienti c ON pv.cliente_id = c.id
       JOIN spazi s ON pv.spazio_id = s.id
       ORDER BY pv.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// GET /api/preventivi/:id - dettaglio singolo preventivo
router.get('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pv.*,
              c.nome AS cliente_nome, c.cognome AS cliente_cognome,
              c.email AS cliente_email, c.telefono AS cliente_telefono,
              c.indirizzo AS cliente_indirizzo,
              c.codice_fiscale, c.p_iva,
              s.nome AS spazio_nome, s.prezzo_giorno, s.dimensioni,
              pr.id AS prenotazione_id
       FROM preventivi pv
       JOIN clienti c ON pv.cliente_id = c.id
       JOIN spazi s ON pv.spazio_id = s.id
       LEFT JOIN prenotazioni pr ON pr.preventivo_id = pv.id
       WHERE pv.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Preventivo non trovato' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// POST /api/preventivi - crea nuovo preventivo
router.post('/', auth, async (req, res) => {
  const { cliente_id, spazio_id, data_inizio, data_fine, note } = req.body;

  if (!cliente_id || !spazio_id || !data_inizio || !data_fine) {
    return res.status(400).json({ error: 'cliente_id, spazio_id, data_inizio e data_fine sono obbligatori' });
  }

  if (new Date(data_inizio) >= new Date(data_fine)) {
    return res.status(400).json({ error: 'La data di inizio deve essere precedente alla data di fine' });
  }

  try {
    // Recupera prezzo giornaliero dello spazio
    const spazio = await pool.query(
      'SELECT prezzo_giorno FROM spazi WHERE id = $1 AND stato = \'ATTIVO\'',
      [spazio_id]
    );
    if (spazio.rows.length === 0) {
      return res.status(404).json({ error: 'Spazio non trovato o non attivo' });
    }

    const prezzoGiorno = parseFloat(spazio.rows[0].prezzo_giorno);
    const calcolo = calcolaImporto(data_inizio, data_fine, prezzoGiorno);

    const result = await pool.query(
      `INSERT INTO preventivi (cliente_id, spazio_id, data_inizio, data_fine, importo_totale, note, stato)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [cliente_id, spazio_id, data_inizio, data_fine, calcolo.importo, note, STATI_PREVENTIVO.BOZZA]
    );

    res.status(201).json({
      ...result.rows[0],
      dettaglio: {
        giorni: calcolo.giorni,
        prezzo_giorno: prezzoGiorno,
        importo_netto: calcolo.importo,
        importo_iva: (calcolo.importo * 22 / 100).toFixed(2),
        importo_totale: (calcolo.importo * 1.22).toFixed(2)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// PUT /api/preventivi/:id - modifica preventivo
router.put('/:id/modifica', auth, async (req, res) => {
  const { cliente_id, spazio_id, data_inizio, data_fine, note } = req.body;

  try {
    const esistente = await pool.query(
      'SELECT * FROM preventivi WHERE id = $1',
      [req.params.id]
    );
    if (esistente.rows.length === 0) {
      return res.status(404).json({ error: 'Preventivo non trovato' });
    }
 
    const attuale = esistente.rows[0];
 
    // Un preventivo accettato, rifiutato o annullato non può essere modificato
    if ([STATI_PREVENTIVO.ACCETTATO, STATI_PREVENTIVO.RIFIUTATO, STATI_PREVENTIVO.ANNULLATO].includes(attuale.stato)) {
      return res.status(400).json({ error: `Un preventivo in stato ${attuale.stato} non può essere modificato` });
    }
 
    const nuovoInizio = data_inizio || attuale.data_inizio;
    const nuovaFine = data_fine || attuale.data_fine;
    const nuovoSpazio = spazio_id || attuale.spazio_id;
 
    // Ricalcola importo se cambiano date o spazio
    const spazio = await pool.query(
      'SELECT prezzo_giorno FROM spazi WHERE id = $1',
      [nuovoSpazio]
    );
    const prezzoGiorno = parseFloat(spazio.rows[0].prezzo_giorno);
    const calcolo = calcolaImporto(nuovoInizio, nuovaFine, prezzoGiorno);
 
    // Se il preventivo era già stato inviato, una modifica ai dati lo
    // invalida: torna in BOZZA finché non viene re-inviato esplicitamente.
    // data_invio NON viene toccata qui: resta lo storico dell'ultimo invio
    // reale, valorizzata solo da POST /:id/invia.
    const nuovoStato = attuale.stato === STATI_PREVENTIVO.INVIATO ? STATI_PREVENTIVO.BOZZA : attuale.stato;
 
    const result = await pool.query(
      `UPDATE preventivi
       SET cliente_id = COALESCE($1, cliente_id),
           spazio_id = COALESCE($2, spazio_id),
           data_inizio = COALESCE($3, data_inizio),
           data_fine = COALESCE($4, data_fine),
           stato = $5,
           note = COALESCE($6, note),
           importo_totale = $7
       WHERE id = $8
       RETURNING *`,
      [cliente_id, spazio_id, data_inizio, data_fine, nuovoStato, note, calcolo.importo, req.params.id]
    );
 
    res.json({
      ...result.rows[0],
      dettaglio: {
        giorni: calcolo.giorni,
        prezzo_giorno: prezzoGiorno,
        importo_netto: calcolo.importo,
        importo_iva: (calcolo.importo * 22 / 100).toFixed(2),
        importo_totale: (calcolo.importo * 1.22).toFixed(2)
      },
      ...(nuovoStato !== attuale.stato && {
        avviso: 'Il preventivo era stato inviato: è necessario reinviarlo al cliente.'
      })
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// POST /api/preventivi/:id/invia - invia (o re-invia) il preventivo al cliente
// Unico punto che valorizza stato = INVIATO e data_invio = NOW(), sia al
// primo invio sia su invii successivi dopo una modifica.
router.post('/:id/invia', auth, async (req, res) => {
  try {
    const esistente = await pool.query(
      'SELECT * FROM preventivi WHERE id = $1',
      [req.params.id]
    );
    if (esistente.rows.length === 0) {
      return res.status(404).json({ error: 'Preventivo non trovato' });
    }
 
    const attuale = esistente.rows[0];
 
    if ([STATI_PREVENTIVO.ACCETTATO, STATI_PREVENTIVO.RIFIUTATO, STATI_PREVENTIVO.ANNULLATO].includes(attuale.stato)) {
      return res.status(400).json({ error: `Un preventivo in stato ${attuale.stato} non può essere inviato` });
    }
 
    const result = await pool.query(
      `UPDATE preventivi
       SET stato = $1, data_invio = NOW()
       WHERE id = $2
       RETURNING *`,
      [STATI_PREVENTIVO.INVIATO, req.params.id]
    );
 
    res.json({ message: 'Preventivo inviato', preventivo: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// POST /api/preventivi/:id/converti - converti preventivo in prenotazione
router.post('/:id/converti', auth, async (req, res) => {
  try {
    const preventivo = await pool.query(
      'SELECT * FROM preventivi WHERE id = $1',
      [req.params.id]
    );
    if (preventivo.rows.length === 0) {
      return res.status(404).json({ error: 'Preventivo non trovato' });
    }

    const pv = preventivo.rows[0];

    if (pv.stato == STATI_PREVENTIVO.RIFIUTATO || pv.stato === STATI_PREVENTIVO.ANNULLATO || pv.stato === STATI_PREVENTIVO.ACCETTATO) {
      return res.status(400).json({ error: 'Non è possibile convertire un preventivo rifiutato, annullato o già accettato' });
    }

    // Controlla se esiste già una prenotazione collegata
    const esistePrenotazione = await pool.query(
      'SELECT id FROM prenotazioni WHERE preventivo_id = $1',
      [req.params.id]
    );
    if (esistePrenotazione.rows.length > 0) {
      return res.status(400).json({ error: 'Esiste già una prenotazione collegata a questo preventivo' });
    }

    // Controlla sovrapposizioni
    const sovrapposizione = await pool.query(
      `SELECT id FROM prenotazioni
       WHERE spazio_id = $1
         AND stato NOT IN ('ANNULLATA', 'CONCLUSA')
         AND (data_inizio, data_fine) OVERLAPS ($2::timestamp, $3::timestamp)`,
      [pv.spazio_id, pv.data_inizio, pv.data_fine]
    );
    if (sovrapposizione.rows.length > 0) {
      return res.status(409).json({ error: 'Lo spazio non è più disponibile nel periodo del preventivo' });
    }

    // Crea la prenotazione e aggiorna stato preventivo in transazione
    await pool.query('BEGIN');

    const prenotazione = await pool.query(
      `INSERT INTO prenotazioni
        (cliente_id, spazio_id, preventivo_id, data_inizio, data_fine, modificato_da_id, data_ultima_modifica)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [pv.cliente_id, pv.spazio_id, pv.id, pv.data_inizio, pv.data_fine, req.utente.id]
    );

    await pool.query(
      'UPDATE preventivi SET stato = $1 WHERE id = $2',
      [STATI_PREVENTIVO.ACCETTATO, req.params.id]
    );

    await pool.query('COMMIT');

    res.status(201).json({
      message: 'Preventivo convertito in prenotazione con successo',
      prenotazione: prenotazione.rows[0]
    });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// PUT /api/preventivi/:id/rifiuta-annulla - rifiuta o annulla preventivo
router.put('/:id/rifiuta-annulla', auth, async (req, res) => {
  try {
    const esistente = await pool.query(
      'SELECT * FROM preventivi WHERE id = $1',
      [req.params.id]
    );
    if (esistente.rows.length === 0) {
      return res.status(404).json({ error: 'Preventivo non trovato' });
    }

    if (esistente.rows[0].stato === STATI_PREVENTIVO.ACCETTATO) {
      return res.status(400).json({ error: 'Non è possibile rifiutare o annullare un preventivo già accettato' });
    }

    const nuovoStato = req.body.stato || STATI_PREVENTIVO.RIFIUTATO;
    if (![STATI_PREVENTIVO.RIFIUTATO, STATI_PREVENTIVO.ANNULLATO].includes(nuovoStato)) {
      return res.status(400).json({ error: 'Stato non valido. Valori ammessi: RIFIUTATO, ANNULLATO' });
    }

    const result = await pool.query(
      'UPDATE preventivi SET stato = $1 WHERE id = $2 RETURNING *',
      [nuovoStato, req.params.id]
    );
    res.json({ message: `Preventivo ${nuovoStato.toLowerCase()}`, preventivo: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// GET /api/preventivi/aperti - elenco preventivi aperti (stato = INVIATO)
router.get('/aperti', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM preventivi WHERE stato = $1 ORDER BY data_invio DESC',
      [STATI_PREVENTIVO.INVIATO]
    );
    res.json({ preventivi: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// GET /api/preventivi/da-inviare - elenco preventivi da inviare (stato = BOZZA)
router.get('/da-inviare', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM preventivi WHERE stato = $1 ORDER BY created_at DESC',
      [STATI_PREVENTIVO.BOZZA]
    );
    res.json({ preventivi: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});


module.exports = router;