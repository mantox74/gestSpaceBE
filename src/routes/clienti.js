const express = require('express');
const router = express.Router();
const pool = require('../db');
const auth = require('../middleware/auth');

// POST /api/clienti/nuovo - crea nuovo cliente
router.post('/nuovo', auth, async (req, res) => {
  const { nome, cognome, email, telefono, indirizzo, numero_civico, cap, citta, provincia, codice_fiscale, p_iva } = req.body;

  if (!nome || !cognome) {
    return res.status(400).json({ error: 'Nome e cognome sono obbligatori' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO clienti (nome, cognome, email, telefono, indirizzo, numero_civico, cap, citta, provincia, codice_fiscale, p_iva)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [nome, cognome, email, telefono, indirizzo, numero_civico, cap, citta, provincia, codice_fiscale, p_iva]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// GET /api/clienti/:id - dettaglio singolo cliente
router.get('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*,
              COUNT(p.id) AS totale_prenotazioni,
              MAX(p.created_at) AS ultima_prenotazione
       FROM clienti c
       LEFT JOIN prenotazioni p ON p.cliente_id = c.id
       WHERE c.id = $1
       GROUP BY c.id`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cliente non trovato' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// POST /api/clienti - ricerca / export
router.post('/', auth, async (req, res) => {
  const {
    search,
    orderBy = 'cognome',
    orderDir = 'ASC',
    page,
    limit
  } = req.body;

  // Whitelist orderBy
  const campiOrdinamento = ['nome', 'cognome', 'email', 'created_at'];
  const ordinamento = campiOrdinamento.includes(orderBy) ? orderBy : 'cognome';
  const direzione = orderDir === 'DESC' ? 'DESC' : 'ASC';

  try {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (search) {
      conditions.push(
        `(nome ILIKE $${idx} OR cognome ILIKE $${idx} OR email ILIKE $${idx} OR codice_fiscale ILIKE $${idx} OR p_iva ILIKE $${idx})`
      );
      params.push(`%${search}%`);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count totale
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM clienti ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Query principale con conteggio prenotazioni
    const isPaginato = page && limit;
    let query = `
      SELECT c.*,
             COUNT(p.id) AS totale_prenotazioni,
             MAX(p.created_at) AS ultima_prenotazione
      FROM clienti c
      LEFT JOIN prenotazioni p ON p.cliente_id = c.id
      ${where}
      GROUP BY c.id
      ORDER BY ${ordinamento} ${direzione}`;

    if (isPaginato) {
      const pagina = parseInt(page);
      const limite = Math.min(parseInt(limit), 100);
      const offset = (pagina - 1) * limite;
      query += ` LIMIT $${idx} OFFSET $${idx + 1}`;
      params.push(limite, offset);
    }

    const result = await pool.query(query, params);

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

// PUT /api/clienti/:id - modifica cliente
router.put('/:id', auth, async (req, res) => {
  const { nome, cognome, email, telefono, indirizzo, numero_civico, cap, citta, provincia, codice_fiscale, p_iva } = req.body;

  try {
    const result = await pool.query(
      `UPDATE clienti
       SET nome = COALESCE($1, nome),
           cognome = COALESCE($2, cognome),
           email = COALESCE($3, email),
           telefono = COALESCE($4, telefono),
           indirizzo = COALESCE($5, indirizzo),
           numero_civico = COALESCE($6, numero_civico),
           cap = COALESCE($7, cap),
           citta = COALESCE($8, citta),
           provincia = COALESCE($9, provincia),
           codice_fiscale = COALESCE($10, codice_fiscale),
           p_iva = COALESCE($11, p_iva)
       WHERE id = $12
       RETURNING *`,
      [nome, cognome, email, telefono, indirizzo, numero_civico, cap, citta, provincia, codice_fiscale, p_iva, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cliente non trovato' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// DELETE /api/clienti/:id - elimina cliente
router.delete('/:id', auth, async (req, res) => {
  try {
    // Controlla se ha prenotazioni collegate
    const prenotazioni = await pool.query(
      'SELECT id FROM prenotazioni WHERE cliente_id = $1 LIMIT 1',
      [req.params.id]
    );
    if (prenotazioni.rows.length > 0) {
      return res.status(400).json({ error: 'Impossibile eliminare un cliente con prenotazioni collegate' });
    }

    const result = await pool.query(
      'DELETE FROM clienti WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cliente non trovato' });
    }
    res.json({ message: 'Cliente eliminato' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

module.exports = router;