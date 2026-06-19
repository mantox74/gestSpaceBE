const express = require('express');
const router = express.Router();
const pool = require('../db');
const auth = require('../middleware/auth');

// POST /api/spazi/nuovo - crea nuovo spazio
router.post('/nuovo', auth, async (req, res) => {
  const { nome, descrizione, lunghezza, larghezza, altezza, prezzo_giorno, note } = req.body;

  if (!nome || !prezzo_giorno) {
    return res.status(400).json({ error: 'Nome e prezzo giornaliero sono obbligatori' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO spazi (nome, descrizione, lunghezza, larghezza, altezza, prezzo_giorno, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [nome, descrizione, lunghezza, larghezza, altezza, prezzo_giorno, note]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// GET /api/spazi/:id - dettaglio singolo spazio con fasce prezzo
router.get('/:id', auth, async (req, res) => {
  try {
    const spazio = await pool.query(
      'SELECT * FROM spazi WHERE id = $1',
      [req.params.id]
    );
    if (spazio.rows.length === 0) {
      return res.status(404).json({ error: 'Spazio non trovato' });
    }

    // Recupera anche le fasce prezzo associate
    const fasce = await pool.query(
      `SELECT * FROM spazi_prezzi WHERE spazio_id = $1 ORDER BY durata_min_giorni ASC`,
      [req.params.id]
    );

    res.json({ ...spazio.rows[0], fasce_prezzo: fasce.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// POST /api/spazi - ricerca / export
router.post('/', auth, async (req, res) => {
  const {
    search,
    stato,
    prezzo_min,
    prezzo_max,
    lunghezza_min,
    larghezza_min,
    altezza_min,
    disponibile_da,
    disponibile_a,
    orderBy = 'nome',
    orderDir = 'ASC',
    page,
    limit
  } = req.body || {};

  // Whitelist orderBy per evitare SQL injection
  const campiOrdinamento = ['nome', 'prezzo_giorno', 'lunghezza', 'larghezza', 'altezza', 'created_at'];
  const ordinamento = campiOrdinamento.includes(orderBy) ? orderBy : 'nome';
  const direzione = orderDir === 'DESC' ? 'DESC' : 'ASC';

  try {
    const conditions = [];
    const params = [];
    let idx = 1;

    // Testo libero
    if (search) {
      conditions.push(`(nome ILIKE $${idx} OR descrizione ILIKE $${idx} OR note ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    // Stato
    if (stato) {
      conditions.push(`stato = $${idx}`);
      params.push(stato);
      idx++;
    }

    // Range prezzo
    if (prezzo_min) {
      conditions.push(`prezzo_giorno >= $${idx}`);
      params.push(prezzo_min);
      idx++;
    }
    if (prezzo_max) {
      conditions.push(`prezzo_giorno <= $${idx}`);
      params.push(prezzo_max);
      idx++;
    }

    // Dimensioni minime
    if (lunghezza_min) {
      conditions.push(`lunghezza >= $${idx}`);
      params.push(lunghezza_min);
      idx++;
    }
    if (larghezza_min) {
      conditions.push(`larghezza >= $${idx}`);
      params.push(larghezza_min);
      idx++;
    }
    if (altezza_min) {
      conditions.push(`altezza >= $${idx}`);
      params.push(altezza_min);
      idx++;
    }

    // Disponibilità per periodo
    if (disponibile_da && disponibile_a) {
      conditions.push(`id NOT IN (
        SELECT spazio_id FROM prenotazioni
        WHERE stato NOT IN ('ANNULLATA', 'CONCLUSA')
        AND (data_inizio, data_fine) OVERLAPS ($${idx}::timestamp, $${idx + 1}::timestamp)
      )`);
      params.push(disponibile_da, disponibile_a);
      idx += 2;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count totale
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM spazi ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Paginazione
    const isPaginato = page && limit;
    let query = `SELECT * FROM spazi ${where} ORDER BY ${ordinamento} ${direzione}`;

    if (isPaginato) {
      const pagina = parseInt(page);
      const limite = Math.min(parseInt(limit), 100);
      const offset = (pagina - 1) * limite;
      query += ` LIMIT $${idx} OFFSET $${idx + 1}`;
      params.push(limite, offset);
    }

    const result = await pool.query(query, params);

    // Risposta paginata o export
    if (isPaginato) {
      const pagina = parseInt(page);
      const limite = Math.min(parseInt(limit), 100);
      res.json({
        data: result.rows,
        pagination: {
          total,
          page: pagina,
          limit: limite,
          totalPages: Math.ceil(total / limite),
          hasNext: pagina * limite < total,
          hasPrev: pagina > 1
        }
      });
    } else {
      res.json({ data: result.rows, total });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// PUT /api/spazi/:id - modifica spazio
router.put('/:id', auth, async (req, res) => {
  const { nome, descrizione, lunghezza, larghezza, altezza, prezzo_giorno, stato, note } = req.body;

  try {
    const result = await pool.query(
      `UPDATE spazi
       SET nome = COALESCE($1, nome),
           descrizione = COALESCE($2, descrizione),
           lunghezza = COALESCE($3, lunghezza),
           larghezza = COALESCE($4, larghezza),
           altezza = COALESCE($5, altezza),
           prezzo_giorno = COALESCE($6, prezzo_giorno),
           stato = COALESCE($7, stato),
           note = COALESCE($8, note)
       WHERE id = $9
       RETURNING *`,
      [nome, descrizione, lunghezza, larghezza, altezza, prezzo_giorno, stato, note, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Spazio non trovato' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// DELETE /api/spazi/:id - disattiva spazio (soft delete)
router.delete('/:id', auth, async (req, res) => {
  try {
    // Controlla se ha prenotazioni attive
    const attive = await pool.query(
      `SELECT id FROM prenotazioni
       WHERE spazio_id = $1 AND stato IN ('CONFERMATA', 'IN_CORSO')`,
      [req.params.id]
    );
    if (attive.rows.length > 0) {
      return res.status(400).json({ error: 'Impossibile disattivare uno spazio con prenotazioni attive' });
    }

    const result = await pool.query(
      `UPDATE spazi SET stato = 'NON_ATTIVO' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Spazio non trovato' });
    }
    res.json({ message: 'Spazio disattivato', spazio: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

module.exports = router;