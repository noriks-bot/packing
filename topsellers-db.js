// [2026-08-16 Dejan] TOPSELLERS BAZA (SQLite) — zanesljiv 14-dnevni seznam naročil.
// Zakaj baza: prejšnje JSON skladišče je bilo nezanesljivo (eno pokvarjeno naročilo z 1,1 mio
// postavkami ga je napihnilo na 108 MB, celoten fajl se je bral/pisal ob vsakem zahtevku).
// Uporabljamo `node:sqlite` — VGRAJEN v Node 22, brez npm odvisnosti.
//
// Vsebina: vsa naročila zadnjih 14 dni (vsi statusi). Polni se:
//   1) enkraten polni 14-dnevni uvoz (ob prvem zagonu / po daljšem izpadu, max 1x/24h),
//   2) inkrementalno iz rednih 5-dnevnih packing sync-ov (brez dodatnih MK klicev),
//   3) urno osveževanje enega starejšega dneva po vrsti (rotacija) — 1 poceni klic/uro,
//      da se poberejo tudi kasnejše spremembe statusov (npr. Novo -> Odpremljen).
'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(__dirname, 'data', 'topsellers.db');
const KEEP_DAYS = 30; // [2026-08-18 Dejan] izjema: hranimo 21 dni, polnjenje ostane 14-dnevno

// Varovalke proti smetem (isto pravilo kot dash2): absurdni zneski / količine ne gredo v bazo.
const MAX_EUR = 800;
const MAX_ITEMS = 300;
const RATES = { EUR: 1, CZK: 0.04112, PLN: 0.23565, HUF: 0.00278, HRK: 0.133, RON: 0.19111, BGN: 0.51 };

let _db = null;
function db() {
    if (_db) return _db;
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    _db = new DatabaseSync(DB_FILE);
    _db.exec(`
        CREATE TABLE IF NOT EXISTS orders (
            id          TEXT PRIMARY KEY,
            order_date  TEXT NOT NULL,
            order_time  TEXT,
            customer    TEXT,
            country     TEXT,
            status      TEXT,
            total       TEXT,
            currency    TEXT,
            products    TEXT,
            updated_at  TEXT,
            wc_id       TEXT,
            mk_id       TEXT,
            eshop       TEXT,
            buyer_ord   TEXT,
            shipped_date TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date);
        CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
        CREATE TABLE IF NOT EXISTS cache (
            k         TEXT PRIMARY KEY,
            cached_at TEXT NOT NULL,
            orders    TEXT NOT NULL
        );
    `);
    // [2026-08-25 Dejan] Migracija obstojece baze: gumba do WooCommerce in Metakocke.
    for (const col of ['wc_id', 'mk_id', 'eshop', 'buyer_ord', 'shipped_date']) {
        try { _db.exec(`ALTER TABLE orders ADD COLUMN ${col} TEXT`); } catch (_) {}
    }
    try { _db.exec('PRAGMA journal_mode = WAL'); } catch (_) {}
    return _db;
}

function dayStr(offset) {
    return new Date(Date.now() + (offset || 0) * 86400000).toISOString().slice(0, 10);
}

function isJunk(o) {
    const rate = RATES[o.currency || 'EUR'] || 1;
    if ((parseFloat(o.total || 0) * rate) > MAX_EUR) return true;
    let n = 0;
    for (const p of (o.products || [])) n += (p.items || []).length;
    return n > MAX_ITEMS;
}

// Vstavi/posodobi naročila. Vrne { inserted, skipped }.
function upsertMany(orders) {
    if (!Array.isArray(orders) || !orders.length) return { inserted: 0, skipped: 0 };
    const d = db();
    const stmt = d.prepare(`
        INSERT INTO orders (id, order_date, order_time, customer, country, status, total, currency, products, updated_at, wc_id, mk_id, eshop, buyer_ord, shipped_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            order_date = excluded.order_date, order_time = excluded.order_time,
            customer = excluded.customer, country = excluded.country, status = excluded.status,
            total = excluded.total, currency = excluded.currency, products = excluded.products,
            updated_at = excluded.updated_at,
            wc_id = COALESCE(NULLIF(excluded.wc_id, ''), orders.wc_id),
            mk_id = COALESCE(NULLIF(excluded.mk_id, ''), orders.mk_id),
            eshop = COALESCE(NULLIF(excluded.eshop, ''), orders.eshop),
            buyer_ord = COALESCE(NULLIF(excluded.buyer_ord, ''), orders.buyer_ord),
            shipped_date = COALESCE(NULLIF(excluded.shipped_date, ''), orders.shipped_date)
    `);
    const del = d.prepare('DELETE FROM orders WHERE id = ?');
    const now = new Date().toISOString();
    let inserted = 0, skipped = 0;
    d.exec('BEGIN');
    try {
        for (const o of orders) {
            const id = o && (o.id || o.wcRef);
            if (!id) continue;
            if (isJunk(o)) { del.run(String(id)); skipped++; continue; }
            const date = String(o.orderDate || o.date || '').slice(0, 10);
            if (!date) { skipped++; continue; }
            const products = (o.products || []).map(p => ({
                label: p.label || '',
                code: p.code || '',
                items: (p.items || []).slice(0, MAX_ITEMS).map(it => ({ type: it.type || '', color: it.color || '', size: it.size || '', oznaka: it.oznaka || '' }))
            }));
            stmt.run(String(id), date, String(o.orderTime || o.time || ''), String(o.customer || ''),
                     String(o.country || ''), String(o.status || ''), String(o.total || ''),
                     String(o.currency || 'EUR'), JSON.stringify(products), now,
                     String(o.wcId || ''), String(o.mkId || ''), String(o.eshopUrl || o.eshop || o._eshop || ''), String(o.buyerOrder || ''));
            inserted++;
        }
        d.exec('COMMIT');
    } catch (e) {
        try { d.exec('ROLLBACK'); } catch (_) {}
        throw e;
    }
    return { inserted, skipped };
}

// Naročila zadnjih N dni (po želji filtrirana po statusu — prefiks, kot v MK).
function getOrders({ days = KEEP_DAYS, status = null, limit = 20000 } = {}) {
    const cutoff = dayStr(-(days - 1));
    const rows = status
        ? db().prepare('SELECT * FROM orders WHERE order_date >= ? AND status LIKE ? ORDER BY order_date DESC, order_time DESC LIMIT ?')
              .all(cutoff, status + '%', limit)
        : db().prepare('SELECT * FROM orders WHERE order_date >= ? ORDER BY order_date DESC, order_time DESC LIMIT ?')
              .all(cutoff, limit);
    return rows.map(r => ({
        id: r.id, customer: r.customer, country: r.country, status: r.status,
        date: r.order_date, time: r.order_time, orderDate: r.order_date, orderTime: r.order_time,
        total: r.total, currency: r.currency,
        wcId: r.wc_id || '', mkId: r.mk_id || '', eshop: r.eshop || '', eshopUrl: r.eshop || '',
        buyerOrder: r.buyer_ord || '', shippedDate: r.shipped_date || '',
        isExchange: /menjav|zamjen|zamen|csere|wymian|schimb|\u03b1\u03bd\u03c4\u03b1\u03bb\u03bb\u03b1\u03b3|cambio|umtausch|exchange/i.test(String(r.buyer_ord || '')),
        products: (() => { try { return JSON.parse(r.products || '[]'); } catch (_) { return []; } })(),
        // [2026-08-27 Dejan] Glavna stran pricakuje TUDI ravni seznam `items` (tako ga
        // sestavi obicajna pot iz Metakocke). Brez njega izris pade z "Cannot read
        // properties of undefined (reading 'forEach')". Baza mora vracati ISTO obliko
        // kot predpomnilnik — sicer se stran obnasa razlicno glede na vir podatkov.
        items: (() => {
            try { return JSON.parse(r.products || '[]').map(p => p.items || []); }
            catch (_) { return []; }
        })()
    }));
}

// Pregled pokritosti: koliko naročil na dan v oknu.
function coverage(days = KEEP_DAYS) {
    const cutoff = dayStr(-(days - 1));
    const rows = db().prepare('SELECT order_date, COUNT(*) n FROM orders WHERE order_date >= ? GROUP BY order_date ORDER BY order_date').all(cutoff);
    const byDay = {};
    for (const r of rows) byDay[r.order_date] = r.n;
    const missing = [];
    for (let i = 1; i < days; i++) { const dd = dayStr(-i); if (!byDay[dd]) missing.push(dd); }
    const total = db().prepare('SELECT COUNT(*) n FROM orders').get().n;
    return { byDay, missing, total, oldest: rows.length ? rows[0].order_date : null };
}

// Koliko naročil na dan je še v "živem" statusu (se lahko še spremeni — DELAY, Novo,
// Pripravljen, Problem, Odpremljen...). Dokončni statusi se ne spreminjajo več, zato jih
// pri osveževanju ne lovimo. Vrne { 'YYYY-MM-DD': stPending }.
const FINAL_STATUSES = ['Zaključeno', 'Brisan', 'Preklican', 'Črna lista', 'Duplikat', 'TEST'];
function pendingByDay(days = KEEP_DAYS) {
    const cutoff = dayStr(-(days - 1));
    const rows = db().prepare('SELECT order_date, status, COUNT(*) n FROM orders WHERE order_date >= ? GROUP BY order_date, status').all(cutoff);
    const out = {};
    for (const r of rows) {
        if (FINAL_STATUSES.some(f => (r.status || '').startsWith(f))) continue;
        out[r.order_date] = (out[r.order_date] || 0) + r.n;
    }
    return out;
}

// Pobriši naročila starejša od okna (baza ostane majhna in hitra).
function prune(days = KEEP_DAYS) {
    const cutoff = dayStr(-(days - 1));
    const r = db().prepare('DELETE FROM orders WHERE order_date < ?').run(cutoff);
    return r.changes || 0;
}

// === [2026-08-16 FAZA3.2] CACHE NAROCIL v SQLite (nadomesti orders-cache.json) ===
// Odpravi read-modify-write dirke (6 mest je bralo 4MB JSON in ga pisalo celega nazaj)
// in 4MB JSON.parse na VSAK zahtevek — zdaj indeksiran dostop do enega kljuca.
function cacheGet(k) {
    const r = db().prepare('SELECT cached_at, orders FROM cache WHERE k = ?').get(String(k));
    if (!r) return null;
    try { return { cachedAt: r.cached_at, orders: JSON.parse(r.orders) }; }
    catch (_) { return null; }
}
function cacheGetAll() {
    const out = {};
    for (const r of db().prepare('SELECT k, cached_at, orders FROM cache').all()) {
        try { out[r.k] = { cachedAt: r.cached_at, orders: JSON.parse(r.orders) }; } catch (_) {}
    }
    return out;
}
function cacheSet(k, orders) {
    const d = db();
    d.prepare(`INSERT INTO cache (k, cached_at, orders) VALUES (?, ?, ?)
               ON CONFLICT(k) DO UPDATE SET cached_at = excluded.cached_at, orders = excluded.orders`)
     .run(String(k), new Date().toISOString(), JSON.stringify(orders || []));
    // pokrov na 30 kljucev (kot prej)
    // [2026-08-19 Dejan] Vroci kljuci strani (…_last3d, …_last30d) se NIKOLI ne izlocijo.
    // Enodnevni kljuci (…_2026-08-14) so enkratni; ce jih je vec kot 30, so prej izrinili
    // glavno stran iz predpomnilnika -> vsak obisk skladisca je sel na Metakocko (pocasno).
    d.prepare("DELETE FROM cache WHERE k NOT LIKE '%last%' AND k NOT IN (SELECT k FROM cache WHERE k NOT LIKE '%last%' ORDER BY cached_at DESC LIMIT 20)").run();
}
// Enkratna selitev iz orders-cache.json (samo ce je cache tabela prazna).
function cacheImportFromJson(jsonPath) {
    try {
        if (db().prepare('SELECT COUNT(*) n FROM cache').get().n > 0) return 0;
        if (!fs.existsSync(jsonPath)) return 0;
        const all = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        let n = 0;
        for (const [k, v] of Object.entries(all)) {
            if (!v || !Array.isArray(v.orders)) continue;
            db().prepare('INSERT OR REPLACE INTO cache (k, cached_at, orders) VALUES (?, ?, ?)')
                .run(k, v.cachedAt || new Date(0).toISOString(), JSON.stringify(v.orders));
            n++;
        }
        if (n) console.log(`[TopsellersDB] cache uvozen iz JSON: ${n} kljucev`);
        return n;
    } catch (e) { console.error('[TopsellersDB] cache uvoz:', e.message); return 0; }
}

function setMeta(k, v) {
    db().prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(String(k), String(v));
}
function getMeta(k) {
    const r = db().prepare('SELECT v FROM meta WHERE k = ?').get(String(k));
    return r ? r.v : null;
}

// Enkratna selitev starega JSON skladišča v bazo (če baza še ni napolnjena).
function importFromJson(jsonPath) {
    try {
        if (!fs.existsSync(jsonPath)) return 0;
        const total = db().prepare('SELECT COUNT(*) n FROM orders').get().n;
        if (total > 0) return 0;
        const store = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const list = Object.values(store.orders || {});
        if (!list.length) return 0;
        const res = upsertMany(list);
        prune();
        console.log(`[TopsellersDB] Uvoz iz JSON: ${res.inserted} naročil (preskočenih ${res.skipped})`);
        return res.inserted;
    } catch (e) {
        console.error('[TopsellersDB] Uvoz iz JSON ni uspel:', e.message);
        return 0;
    }
}

module.exports = { upsertMany, getOrders, coverage, prune, setMeta, getMeta, importFromJson, dayStr, pendingByDay,
                   cacheGet, cacheGetAll, cacheSet, cacheImportFromJson, KEEP_DAYS, DB_FILE };
