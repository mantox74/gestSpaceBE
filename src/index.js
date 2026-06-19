const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// LOGGING middleware:
app.use((req, res, next) => {
  console.log(`[In arrivo] ${req.method} su ${req.url}`);
  next();
});

// Routes (le aggiungeremo una alla volta)
app.use('/api/auth', require('./routes/auth'));
app.use('/api/spazi', require('./routes/space'));
app.use('/api/clienti', require('./routes/clienti'));
app.use('/api/prenotazioni', require('./routes/prenotazioni'));
app.use('/api/preventivi', require('./routes/preventivi'));
app.use('/api/fatture', require('./routes/fatture'));

app.listen(PORT, () => {
  console.log(`Server gestSpace in ascolto sulla porta ${PORT}`);
});