// [2026-08-16 FAZA3.4] Avtentikacija — izločena iz server.js.
// Trajne seje (preživijo restart), login/logout, requireAuth middleware.
// install(app) registrira vse v ISTEM vrstnem redu kot prej: login strani,
// /api/login, /api/logout, nato app.use(requireAuth).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./fs-utils');

const APP_DIR = path.join(__dirname, '..');
const SESSIONS_FILE = path.join(APP_DIR, 'data', 'sessions.json');
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 dni

let SESSIONS = {};
try { SESSIONS = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) || {}; } catch (_) {}

function saveSessions() {
    try { writeFileAtomic(SESSIONS_FILE, JSON.stringify(SESSIONS)); }
    catch (e) { console.error('[Sessions] save failed:', e.message); }
}

function parseCookies(cookieHeader) {
    const cookies = {};
    if (cookieHeader) {
        cookieHeader.split(';').forEach(c => {
            const [name, value] = c.split('=').map(x => x.trim());
            if (name && value) cookies[name] = value;
        });
    }
    return cookies;
}

function getSession(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['packing_session'];
    if (!token || !SESSIONS[token]) return null;
    if (Date.now() - SESSIONS[token].created > SESSION_MAX_AGE) {
        delete SESSIONS[token];
        saveSessions();
        return null;
    }
    return SESSIONS[token];
}

function requireAuth(req, res, next) {
    if (req.path === '/api/login' || req.path === '/login.html' || req.path === '/packing/login.html') return next();
    if (req.path === '/api/health') return next();   // [FAZA1] health za watchdog — brez občutljivih podatkov
    // Vzdrževalna endpointa: SAMO pravi localhost. nginx proxyja z 127.0.0.1 in VEDNO
    // doda X-Forwarded-For — pravi lokalni curl je nima. Zahtevamo oboje (varnostni popravek 16.8.).
    if (req.path === '/api/packing/topsellers-resync' || req.path === '/api/packing/topsellers-status') {
        const ip = String(req.socket && req.socket.remoteAddress || '');
        const isProxied = !!(req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
        if ((ip.includes('127.0.0.1') || ip.includes('::1')) && !isProxied) return next();
    }
    if (!getSession(req)) {
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
        return res.redirect('/login.html');
    }
    next();
}

function install(app) {
    // Login strani (pred auth)
    app.get('/login.html', (req, res) => {
        res.sendFile(path.join(APP_DIR, 'public', 'login.html'));
    });
    app.get('/packing/login.html', (req, res) => {
        res.sendFile(path.join(APP_DIR, 'public', 'packing', 'login.html'));
    });

    // Login API — poverilnice iz .env (PACKING_USER/PASS); fallback na stare vrednosti,
    // da skladišče NIKOLI ne ostane zaklenjeno, če .env manjka.
    app.post('/api/login', (req, res) => {
        const { username, password } = req.body;
        const AUTH_USER = process.env.PACKING_USER || 'noriks';
        const AUTH_PASS = process.env.PACKING_PASS || 'noriks';
        if (username === AUTH_USER && password === AUTH_PASS) {
            const token = crypto.randomBytes(32).toString('hex');
            SESSIONS[token] = { username, created: Date.now() };
            saveSessions();
            res.cookie('packing_session', token, { httpOnly: true, sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 * 1000 });
            return res.json({ ok: true });
        }
        res.status(401).json({ error: 'Invalid credentials' });
    });

    // Logout
    app.post('/api/logout', (req, res) => {
        const cookies = parseCookies(req.headers.cookie);
        const token = cookies['packing_session'];
        if (token) { delete SESSIONS[token]; saveSessions(); }
        res.clearCookie('packing_session');
        res.json({ ok: true });
    });

    // Vse pod tem zahteva prijavo
    app.use(requireAuth);
}

module.exports = { install, getSession, requireAuth };
