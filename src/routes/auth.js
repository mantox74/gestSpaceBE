const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
require('dotenv').config();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    // Cerca utente nel DB
    const result = await pool.query(
      'SELECT * FROM utenti WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenziali non valide' });
    }

    const utente = result.rows[0];

    // Controlla che l'utente sia attivo
    if (utente.stato !== 'ATTIVO') {
      return res.status(403).json({ error: 'Utente non attivo' });
    }

    // Verifica password
    const passwordValida = await bcrypt.compare(password, utente.password_hash);
    if (!passwordValida) {
      return res.status(401).json({ error: 'Credenziali non valide' });
    }

    // Aggiorna ultimo accesso
    await pool.query(
      'UPDATE utenti SET ultimo_accesso = NOW() WHERE id = $1',
      [utente.id]
    );

    // Genera token JWT
    const token = jwt.sign(
      { id: utente.id, email: utente.email, ruolo: utente.ruolo, nome: utente.nome, cognome: utente.cognome },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      token,
      utente: {
        id: utente.id,
        email: utente.email,
        nome: utente.nome,
        cognome: utente.cognome,
        ruolo: utente.ruolo,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// POST /api/auth/create (solo ADMIN può creare utenti)
router.post('/create', async (req, res) => {
  const { email, password, nome, cognome, ruolo } = req.body;

  try {
    // Controlla se email già esistente
    const esistente = await pool.query(
      'SELECT id FROM utenti WHERE email = $1',
      [email]
    );
    if (esistente.rows.length > 0) {
      return res.status(400).json({ error: 'Email già registrata' });
    }

    // Hash della password
    const passwordHash = await bcrypt.hash(password, 10);

    // Inserisce utente
    const result = await pool.query(
      `INSERT INTO utenti (email, password_hash, nome, cognome, ruolo)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, nome, cognome, ruolo`,
      [email, passwordHash, nome, cognome, ruolo || 'OPERATORE']
    );

    res.status(201).json({ utente: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// TODO: Implementare la logica per cambiare la password dell'utente
router.put('/cambia-password', async (req, res) => {
  const { id, nuovaPassword, vecchiaPassword } = req.body;
});

module.exports = router;