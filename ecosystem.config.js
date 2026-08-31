// [2026-08-16 FAZA2] pm2 konfiguracija packing aplikacije — V GITU, da ob reprovisionu
// streznika nic ne "izgine" (max_memory_restart prej ni bil nikjer zapisan).
// Skrivnosti NISO tukaj — server.js si jih sam nalozi iz .env (process.loadEnvFile).
// Uporaba: pm2 start ecosystem.config.js  (oz. pm2 reload packing po spremembi kode)
module.exports = {
    apps: [{
        name: 'packing',
        script: 'server.js',
        cwd: '/home/ec2-user/apps/packing',
        exec_mode: 'fork',
        max_memory_restart: '800M',
        // pocasnejsi restart-loop guard: ce app pade takoj po zagonu, pm2 caka
        min_uptime: '20s',
        max_restarts: 10,
        restart_delay: 3000,
        time: true   // timestampi v pm2 logih
    }]
};
