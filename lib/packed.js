// [2026-08-16 FAZA3.4] Skladiščno stanje — izločeno iz server.js.
// SPAKIRANA naročila (deljeno med packing in topsellers UI) + OPOMBE + 60-dnevni arhiv.
// install(app) registrira rute; stanje in datoteke živijo tukaj.
'use strict';
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./fs-utils');

const APP_DIR = path.join(__dirname, '..');
const PACKED_FILE = path.join(APP_DIR, 'data', 'packed-orders.json');
const PACKED_ARCHIVE_FILE = path.join(APP_DIR, 'data', 'packed-archive.json');
const PACKING_NOTES_FILE = path.join(APP_DIR, 'packing-notes.json');
const PACKED_KEEP_DAYS = 60;

function loadPackedOrders() {
    try {
        if (fs.existsSync(PACKED_FILE)) return JSON.parse(fs.readFileSync(PACKED_FILE, 'utf8'));
    } catch (e) { console.error('Packed load error:', e); }
    return {};
}

let packedOrdersData = loadPackedOrders();
let packingNotes = {};
try { packingNotes = JSON.parse(fs.readFileSync(PACKING_NOTES_FILE, 'utf8')); } catch (e) {}

function savePackedOrders(data) {
    writeFileAtomic(PACKED_FILE, JSON.stringify(data, null, 2));
}

// ARHIVIRANJE: zapisi starejši od 60 dni gredo v packed-archive.json (nič se NE izgubi).
// Vrstni red je varen: najprej USPEŠEN zapis arhiva, šele nato odstranitev iz aktivne.
function archiveOldPacked() {
    try {
        const cutoff = Date.now() - PACKED_KEEP_DAYS * 24 * 60 * 60 * 1000;
        const toArchive = {};
        let n = 0;
        for (const [id, v] of Object.entries(packedOrdersData)) {
            const t = v && v.packedAt ? new Date(v.packedAt).getTime() : 0;
            if (t && t < cutoff) { toArchive[id] = v; n++; }
        }
        if (!n) return;
        let archive = {};
        try { archive = JSON.parse(fs.readFileSync(PACKED_ARCHIVE_FILE, 'utf8')) || {}; } catch (_) {}
        Object.assign(archive, toArchive);
        writeFileAtomic(PACKED_ARCHIVE_FILE, JSON.stringify(archive));   // 1) arhiv
        for (const id of Object.keys(toArchive)) delete packedOrdersData[id];
        savePackedOrders(packedOrdersData);                              // 2) aktivna
        razveljaviSeznam();
        console.log(`[Packed/Archive] ${n} zapisov (>${PACKED_KEEP_DAYS} dni) -> arhiv (${Object.keys(archive).length} skupaj), aktivnih ${Object.keys(packedOrdersData).length}`);
    } catch (e) {
        console.error('[Packed/Archive] failed (aktivna datoteka NEDOTAKNJENA):', e.message);
    }
}
setTimeout(archiveOldPacked, 30 * 1000);            // ob zagonu
setInterval(archiveOldPacked, 24 * 60 * 60 * 1000); // 1x na dan

function install(app) {
    // Packed orders API — identične rute kot prej
    app.get('/api/packing/packed-orders', (req, res) => {
        res.json(packedOrdersData);
    });

    app.post('/api/packing/mark-packed', (req, res) => {
        const { orders } = req.body; // { orderId: { packedAt, customer } }
        if (!orders || typeof orders !== 'object') return res.status(400).json({ error: 'Missing orders' });
        Object.assign(packedOrdersData, orders);
        savePackedOrders(packedOrdersData);
        razveljaviSeznam();
        res.json({ ok: true });
    });

    app.post('/api/packing/unpack', (req, res) => {
        const { orderId } = req.body;
        if (!orderId) return res.status(400).json({ error: 'Missing orderId' });
        delete packedOrdersData[orderId];
        savePackedOrders(packedOrdersData);
        razveljaviSeznam();
        res.json({ ok: true });
    });

    // === ORDER NOTES ===
    app.get('/api/packing/notes', (req, res) => {
        res.json(packingNotes);
    });
    app.post('/api/packing/notes', (req, res) => {
        const { orderId, note } = req.body;
        if (!orderId) return res.status(400).json({ error: 'Missing orderId' });
        if (note) {
            packingNotes[orderId] = { note, updatedAt: new Date().toISOString() };
        } else {
            delete packingNotes[orderId];
        }
        try { writeFileAtomic(PACKING_NOTES_FILE, JSON.stringify(packingNotes, null, 2)); } catch (e) { console.error('[Notes] save failed:', e.message); }
        res.json({ ok: true });
    });
}

// [2026-09-07 Dejan] Enoten seznam VSEH spakiranih (aktivni + arhiv) za stran
// /spakirani-paketi. Gradi se lenobno in se prepise samo, ko se kaj res spremeni
// (mark-packed / unpack / arhiviranje) — sicer bi vsak pritisk tipke v iskalniku
// znova zlagal 42.000 zapisov.
let _seznam = null;
let _arhivMtime = 0, _arhivPodatki = null;
function razveljaviSeznam() { _seznam = null; _mnozica = null; }
function beriArhiv() {
    try {
        const st = fs.statSync(PACKED_ARCHIVE_FILE);
        if (!_arhivPodatki || st.mtimeMs !== _arhivMtime) {
            _arhivPodatki = JSON.parse(fs.readFileSync(PACKED_ARCHIVE_FILE, 'utf8')) || {};
            _arhivMtime = st.mtimeMs;
        }
    } catch (e) { _arhivPodatki = _arhivPodatki || {}; }
    return _arhivPodatki;
}
function vsiSpakirani() {
    if (_seznam) return _seznam;
    const zdruzeno = Object.assign({}, beriArhiv(), packedOrdersData);  // aktivni prepisejo arhiv
    const out = [];
    for (const [id, v] of Object.entries(zdruzeno)) {
        if (!v) continue;
        out.push({
            id,
            packedAt: (typeof v === 'string' ? '' : (v.packedAt || '')),
            customer: (typeof v === 'string' ? '' : (v.customer || '')),
            arhiv: !(id in packedOrdersData)
        });
    }
    out.sort((a, b) => String(b.packedAt).localeCompare(String(a.packedAt)));   // najnovejsi najprej
    _seznam = out;
    return out;
}

// Mnozica AKTIVNO spakiranih — stran Predpakiranje jih mora izlociti.
// Arhiva namenoma ne stejemo: tam so narocila, starejsa od 60 dni, prikaz pa
// sega 30 dni nazaj.
let _mnozica = null;
function spakiraniSet() {
    if (!_mnozica) _mnozica = new Set(Object.keys(packedOrdersData));
    return _mnozica;
}

function count() { return Object.keys(packedOrdersData).length; }

module.exports = { install, count, vsiSpakirani, spakiraniSet };
