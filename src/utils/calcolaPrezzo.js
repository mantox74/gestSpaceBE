const pool = require('../db');

/**
 * Calcola il prezzo finale per uno o più spazi
 * @param {Array} righe - [{ spazio_id, data_inizio, data_fine }]
 * @param {Object} scontoManuale - { tipo, valore, nota } oppure null
 * @returns {Object} dettaglio calcolo completo
 */
async function calcolaPrezzo(righe, scontoManuale = null) {
  let totale_lordo = 0;
  const righeCalcolate = [];

  for (const riga of righe) {
    // Recupera spazio
    const spazioResult = await pool.query(
      'SELECT * FROM spazi WHERE id = $1 AND stato = \'ATTIVO\'',
      [riga.spazio_id]
    );
    if (spazioResult.rows.length === 0) {
      throw new Error(`Spazio ${riga.spazio_id} non trovato o non attivo`);
    }
    const spazio = spazioResult.rows[0];

    // Calcola giorni
    const inizio = new Date(riga.data_inizio);
    const fine = new Date(riga.data_fine);
    const giorni = Math.ceil((fine - inizio) / (1000 * 60 * 60 * 24));

    // Cerca sconto durata applicabile
    const prezzoBase = parseFloat(spazio.prezzo_giorno);
    let prezzoFinaleGiorno = prezzoBase;
    let scontoDurata = null;

    const fascia = await pool.query(
      `SELECT * FROM spazi_prezzi
       WHERE spazio_id = $1
         AND durata_min_giorni <= $2
         AND (durata_max_giorni IS NULL OR durata_max_giorni >= $2)
       ORDER BY durata_min_giorni DESC
       LIMIT 1`,
      [riga.spazio_id, giorni]
    );

    if (fascia.rows.length > 0) {
      const f = fascia.rows[0];
      if (f.tipo_sconto === 'PERCENTUALE') {
        prezzoFinaleGiorno = prezzoBase * (1 - parseFloat(f.valore) / 100);
        scontoDurata = { tipo: 'PERCENTUALE', valore: parseFloat(f.valore), prezzo_finale_giorno: prezzoFinaleGiorno };
      } else if (f.tipo_sconto === 'PREZZO_FISSO') {
        prezzoFinaleGiorno = parseFloat(f.valore);
        scontoDurata = { tipo: 'PREZZO_FISSO', valore: parseFloat(f.valore), prezzo_finale_giorno: prezzoFinaleGiorno };
      }
    }

    const subtotale = parseFloat((prezzoFinaleGiorno * giorni).toFixed(2));
    totale_lordo = parseFloat((totale_lordo + subtotale).toFixed(2));

    righeCalcolate.push({
      spazio_id: spazio.id,
      spazio: spazio.nome,
      giorni,
      prezzo_base: prezzoBase,
      sconto_durata: scontoDurata,
      prezzo_giorno_finale: parseFloat(prezzoFinaleGiorno.toFixed(2)),
      subtotale
    });
  }

  // Sconto volume
  let totale_dopo_volume = totale_lordo;
  let scontoVolume = null;
  const numSpazi = righe.length;

  if (numSpazi > 1) {
    const volume = await pool.query(
      `SELECT * FROM sconti_volume
       WHERE spazi_min <= $1 AND attivo = TRUE
       ORDER BY spazi_min DESC
       LIMIT 1`,
      [numSpazi]
    );

    if (volume.rows.length > 0) {
      const v = volume.rows[0];
      let importoSconto = 0;
      if (v.tipo_sconto === 'PERCENTUALE') {
        importoSconto = parseFloat((totale_lordo * parseFloat(v.valore) / 100).toFixed(2));
      } else {
        importoSconto = parseFloat(v.valore);
      }
      totale_dopo_volume = parseFloat((totale_lordo - importoSconto).toFixed(2));
      scontoVolume = {
        tipo: v.tipo_sconto,
        valore: parseFloat(v.valore),
        importo: importoSconto,
        descrizione: v.descrizione
      };
    }
  }

  // Sconto manuale
  let totale_netto = totale_dopo_volume;
  let scontoManualeCalcolato = null;

  if (scontoManuale && scontoManuale.valore) {
    let importoSconto = 0;
    if (scontoManuale.tipo === 'PERCENTUALE') {
      importoSconto = parseFloat((totale_dopo_volume * scontoManuale.valore / 100).toFixed(2));
    } else {
      importoSconto = parseFloat(scontoManuale.valore);
    }
    totale_netto = parseFloat((totale_dopo_volume - importoSconto).toFixed(2));
    scontoManualeCalcolato = {
      tipo: scontoManuale.tipo,
      valore: scontoManuale.valore,
      importo: importoSconto,
      nota: scontoManuale.nota || null
    };
  }

  // IVA
  const ivaPerc = 22;
  const importoIva = parseFloat((totale_netto * ivaPerc / 100).toFixed(2));
  const totale_finale = parseFloat((totale_netto + importoIva).toFixed(2));

  return {
    righe: righeCalcolate,
    totale_lordo,
    sconto_volume: scontoVolume,
    totale_dopo_volume,
    sconto_manuale: scontoManualeCalcolato,
    totale_netto,
    iva: { percentuale: ivaPerc, importo: importoIva },
    totale_finale
  };
}

module.exports = { calcolaPrezzo };