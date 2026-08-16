// [2026-08-16 FAZA3.4] Atomarni zapis datotek — izločen iz server.js.
// temp + rename (atomaren na istem FS) + .prev kopija zadnje dobre verzije.
// Crash/OOM sredi zapisa NE more uničiti datoteke (9.6. se je packed-orders že).
'use strict';
const fs = require('fs');
const path = require('path');

function writeFileAtomic(file, data) {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, data);
    try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.prev'); } catch (_) {}
    fs.renameSync(tmp, file);
}

module.exports = { writeFileAtomic };
