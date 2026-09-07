#!/usr/bin/env node
/* Primerja vrstni red Metakockinih nalepk z nasim sortiranjem ARTIKLI.
 *
 * Uporaba (na strezniku):
 *   node tools/preveri-nalepke.js /tmp/nalepke.json
 *
 * Sam se prijavi v aplikacijo in potegne narocila. Sortirno pravilo je ISTO
 * kot v public/packing/index.html, veja case 'artikli' — ce se tam kaj
 * spremeni, popravi TUDI tu, sicer preverjanje nic ne pove.
 */
const fs = require('fs'), path = require('path'), http = require('http');
const KOREN = path.join(__dirname, '..');

function env(k) {
    const t = fs.readFileSync(path.join(KOREN, '.env'), 'utf8');
    const m = t.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}
function zahtevek(pot, cookie, telo) {
    return new Promise((res, rej) => {
        const opt = { host: '127.0.0.1', port: 3006, path: pot, method: telo ? 'POST' : 'GET',
                      headers: Object.assign({}, cookie ? { Cookie: cookie } : {},
                               telo ? { 'Content-Type': 'application/json' } : {}) };
        const r = http.request(opt, (o) => {
            let b = '';
            o.on('data', c => b += c);
            o.on('end', () => res({ body: b, headers: o.headers }));
        });
        r.on('error', rej);
        if (telo) r.write(JSON.stringify(telo));
        r.end();
    });
}
// --- sortirno pravilo (zrcalo index.html) ---
const prviSSifro = o => { for (const p of (o.products || [])) if (String(p.code || '').trim()) return p; return null; };
const skupnaKolicina = o => { let n = 0; for (const p of (o.products || [])) n += Math.max(1, parseInt(p.amount) || 1); return n || 1; };
const stNarocila = o => parseInt(String(o.id || '').split('/')[0]) || 0;
const sortArtikli = (a, b) => {
    const pa = prviSSifro(a), pb = prviSSifro(b);
    const ca = pa ? String(pa.code).trim() : '', cb = pb ? String(pb.code).trim() : '';
    if (!ca || !cb) { if (ca !== cb) return ca ? -1 : 1; }
    if (ca !== cb) return ca < cb ? 1 : -1;
    const ka = skupnaKolicina(a), kb = skupnaKolicina(b);
    if (ka !== kb) return ka - kb;
    return stNarocila(b) - stNarocila(a);
};
const norm = s => String(s || '').replace(/[^\x20-\x7E]/g, '?').replace(/\s+/g, ' ').trim().toLowerCase();

(async () => {
    const nalepke = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/nalepke.json', 'utf8'));
    const pr = await zahtevek('/api/login', null, { username: env('PACKING_USER'), password: env('PACKING_PASS') });
    const cookie = (pr.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const od = await zahtevek('/api/packing/orders?status=&days=14&limit=20000', cookie);
    const orders = JSON.parse(od.body).orders || [];

    const porabljeni = new Set(), mk = [], nenajdeni = [];
    for (const n of nalepke) {
        const ime = norm(n.stranka), sif = (n.izdelki.match(/NORIKS[A-Z0-9-]*/) || ['?'])[0];
        const kand = orders.filter(o => norm(o.customer) === ime && !porabljeni.has(o.id));
        const izb = kand.find(o => { const p = prviSSifro(o); return p && p.code === sif; }) || kand[0];
        if (!izb) { nenajdeni.push(n); continue; }
        porabljeni.add(izb.id); mk.push(izb);
    }
    const nasi = [...mk].sort(sortArtikli);
    console.log('nalepk: ' + nalepke.length + ' | najdenih: ' + mk.length + ' | ne najdem: ' + nenajdeni.length);
    nenajdeni.forEach(n => console.log('   NE NAJDEM: ' + n.stranka + ' | ' + n.izdelki));
    console.log('\n  #  METAKOCKA                              | APLIKACIJA');
    let ujem = 0;
    const kratko = o => { const p = prviSSifro(o); return (p ? p.code.replace('NORIKS-', '') : '?') + ' ' + o.id + ' ' + (o.customer || ''); };
    for (let i = 0; i < mk.length; i++) {
        const enak = mk[i].id === nasi[i].id; if (enak) ujem++;
        console.log(String(i + 1).padStart(3) + '. ' + kratko(mk[i]).slice(0, 38).padEnd(39) +
                    '| ' + kratko(nasi[i]).slice(0, 38).padEnd(38) + (enak ? '' : ' <-- RAZLIKA'));
    }
    console.log('\n  UJEMANJE: ' + ujem + '/' + mk.length + (ujem === mk.length && mk.length ? '  — POPOLNO' : ''));
    process.exit(ujem === mk.length ? 0 : 1);
})();
