// [2026-08-16 FAZA2] Skrivnosti iz .env (Node 22 vgrajen loader, brez odvisnosti).
// .env je v .gitignore in chmod 600. Ne prepise ze nastavljenih env spremenljivk.
try { process.loadEnvFile(__dirname + '/.env'); } catch (_) { /* .env je opcijski */ }

const express = require('express');
const compression = require('compression');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(compression());
const PORT = 3006;
const DATA_FILE = path.join(__dirname, 'data.json');

// [FAZA3.4] Atomarni zapisi -> lib/fs-utils.js
const { writeFileAtomic } = require('./lib/fs-utils');

// 2) CRASH HANDLERJA: en neujet throw v intervalih ne sme sesuti procesa
//    (prej: pm2 respawn -> vse skladisce odjavljeno). Glasno logiramo za watchdog.
process.on('uncaughtException', err => {
    console.error('[FATAL] uncaughtException:', (err && err.stack) || err);
});
process.on('unhandledRejection', reason => {
    console.error('[FATAL] unhandledRejection:', (reason && reason.stack) || reason);
});







app.use(express.json({ limit: '2mb' }));   // [FAZA3] dovolj za batch mark-packed, premalo za zlorabo RAM

// [FAZA3.4] Avtentikacija (seje, login/logout, requireAuth) -> lib/auth.js
require('./lib/auth').install(app);

app.use(express.static(path.join(__dirname, 'public')));

// [FAZA3.4] Spakirano + opombe + arhiv -> lib/packed.js
const packedMod = require('./lib/packed');
packedMod.install(app);

// Image proxy for CORS - fetch external images and serve with proper headers
app.get('/api/image-proxy', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) {
        return res.status(400).send('Missing url parameter');
    }
    
    try {
        const response = await fetch(imageUrl);
        const buffer = await response.arrayBuffer();
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(Buffer.from(buffer));
    } catch (err) {
        console.error('Image proxy error:', err);
        res.status(500).send('Failed to fetch image');
    }
});

// Load data
function loadData() {
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        return {
            countries: ["HR", "CZ", "PL", "GR", "IT", "HU", "SK", "DE"],
            defaultTasks: [],
            assignees: ["Ajda", "Dejan", "Grega", "Petra", "Teja"],
            countryData: {}
        };
    }
}

// Save data
function saveData(data) {
    writeFileAtomic(DATA_FILE, JSON.stringify(data, null, 2));
}

// Initialize country data if missing
function initCountryData(data, country) {
    if (!data.countryData[country]) {
        data.countryData[country] = { tasks: [], customTasks: [] };
    }
    // Ensure all default tasks exist
    data.defaultTasks.forEach((taskName, index) => {
        const existing = data.countryData[country].tasks.find(t => t.name === taskName);
        if (!existing) {
            data.countryData[country].tasks.push({
                id: `default-${index}`,
                name: taskName,
                done: false,
                assignee: "",
                notes: ""
            });
        }
    });
    return data;
}

// GET all data
app.get('/api/data', (req, res) => {
    let data = loadData();
    // Initialize all countries
    data.countries.forEach(country => {
        data = initCountryData(data, country);
    });
    saveData(data);
    res.json(data);
});

// GET country data
app.get('/api/country/:code', (req, res) => {
    let data = loadData();
    const country = req.params.code.toUpperCase();
    data = initCountryData(data, country);
    saveData(data);
    res.json({
        country: country,
        tasks: data.countryData[country].tasks,
        customTasks: data.countryData[country].customTasks || []
    });
});

// UPDATE task
app.put('/api/country/:code/task/:taskId', (req, res) => {
    const data = loadData();
    const country = req.params.code.toUpperCase();
    const taskId = req.params.taskId;
    const { done, assignee, notes, shortNote, deadline, assignMessage } = req.body;

    if (!data.countryData[country]) {
        return res.status(404).json({ error: 'Country not found' });
    }

    // Check in regular tasks
    let task = data.countryData[country].tasks.find(t => t.id === taskId);
    if (!task) {
        // Check in custom tasks
        task = (data.countryData[country].customTasks || []).find(t => t.id === taskId);
    }

    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }

    if (done !== undefined) task.done = done;
    if (assignee !== undefined) task.assignee = assignee;
    if (notes !== undefined) task.notes = notes;
    if (shortNote !== undefined) task.shortNote = shortNote;
    if (deadline !== undefined) task.deadline = deadline;
    if (assignMessage !== undefined) task.assignMessage = assignMessage;
    if (req.body.category !== undefined) task.category = req.body.category;
    if (req.body.name !== undefined) task.name = req.body.name;
    if (req.body.link !== undefined) task.link = req.body.link;
    if (req.body.linkLabel !== undefined) task.linkLabel = req.body.linkLabel;
    if (req.body.toolType !== undefined) task.toolType = req.body.toolType;

    saveData(data);
    res.json({ success: true, task });
});

// REORDER tasks
app.put('/api/country/:code/reorder', (req, res) => {
    const data = loadData();
    const country = req.params.code.toUpperCase();
    const { taskIds } = req.body;

    if (!data.countryData[country]) {
        return res.status(404).json({ error: 'Country not found' });
    }

    const allTasks = [...data.countryData[country].tasks, ...(data.countryData[country].customTasks || [])];
    
    // Reorder based on taskIds array
    const reorderedTasks = [];
    const reorderedCustom = [];
    
    taskIds.forEach(id => {
        const task = allTasks.find(t => t.id === id);
        if (task) {
            if (task.isCustom) {
                reorderedCustom.push(task);
            } else {
                reorderedTasks.push(task);
            }
        }
    });
    
    // Keep any tasks that weren't in the reorder list (shouldn't happen but safety)
    allTasks.forEach(task => {
        if (!taskIds.includes(task.id)) {
            if (task.isCustom) {
                reorderedCustom.push(task);
            } else {
                reorderedTasks.push(task);
            }
        }
    });
    
    data.countryData[country].tasks = reorderedTasks;
    data.countryData[country].customTasks = reorderedCustom;

    saveData(data);
    res.json({ success: true });
});

// ADD custom task - adds to ALL countries
app.post('/api/country/:code/task', (req, res) => {
    const data = loadData();
    const { name, category, link } = req.body;
    const taskId = `custom-${Date.now()}`;

    // Add task to ALL countries
    data.countries.forEach(country => {
        if (!data.countryData[country]) {
            data.countryData[country] = { tasks: [], customTasks: [] };
        }
        if (!data.countryData[country].customTasks) {
            data.countryData[country].customTasks = [];
        }

        data.countryData[country].customTasks.push({
            id: taskId,
            name: name,
            category: category || 'other',
            done: false,
            assignee: "",
            notes: "",
            shortNote: "",
            link: link || "",
            isCustom: true
        });
    });

    saveData(data);
    res.json({ success: true, taskId });
});

// GET daily log for a task
app.get('/api/country/:code/task/:taskId/daily-log', (req, res) => {
    const data = loadData();
    const country = req.params.code.toUpperCase();
    const taskId = req.params.taskId;

    if (!data.countryData[country]) {
        return res.status(404).json({ error: 'Country not found' });
    }

    // Find task
    let task = data.countryData[country].tasks?.find(t => t.id === taskId);
    if (!task) task = data.countryData[country].customTasks?.find(t => t.id === taskId);
    
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }

    res.json(task.dailyLog || {});
});

// POST mark today as done in daily log
app.post('/api/country/:code/task/:taskId/daily-log', (req, res) => {
    const data = loadData();
    const country = req.params.code.toUpperCase();
    const taskId = req.params.taskId;
    const { by } = req.body;

    if (!data.countryData[country]) {
        return res.status(404).json({ error: 'Country not found' });
    }

    // Find task
    let task = data.countryData[country].tasks?.find(t => t.id === taskId);
    if (!task) task = data.countryData[country].customTasks?.find(t => t.id === taskId);
    
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }

    // Initialize daily log if needed
    if (!task.dailyLog) task.dailyLog = {};
    
    // Add today's entry
    const today = new Date().toISOString().split('T')[0];
    const now = new Date();
    task.dailyLog[today] = {
        done: true,
        by: by || 'Unknown',
        time: now.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })
    };

    saveData(data);
    res.json({ success: true, date: today });
});

// PUT update specific date in daily log
app.put('/api/country/:code/task/:taskId/daily-log/:dateKey', (req, res) => {
    const data = loadData();
    const country = req.params.code.toUpperCase();
    const taskId = req.params.taskId;
    const dateKey = req.params.dateKey;
    const { done, by } = req.body;

    if (!data.countryData[country]) {
        return res.status(404).json({ error: 'Country not found' });
    }

    // Find task
    let task = data.countryData[country].tasks?.find(t => t.id === taskId);
    if (!task) task = data.countryData[country].customTasks?.find(t => t.id === taskId);
    
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }

    // Initialize daily log if needed
    if (!task.dailyLog) task.dailyLog = {};
    
    if (done) {
        const now = new Date();
        task.dailyLog[dateKey] = {
            done: true,
            by: by || 'Unknown',
            time: now.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })
        };
    } else {
        delete task.dailyLog[dateKey];
    }

    saveData(data);
    res.json({ success: true, date: dateKey, done });
});

// DELETE any task
app.delete('/api/country/:code/task/:taskId', (req, res) => {
    const data = loadData();
    const country = req.params.code.toUpperCase();
    const taskId = req.params.taskId;

    if (!data.countryData[country]) {
        return res.status(404).json({ error: 'Country not found' });
    }

    // Try to delete from regular tasks
    const tasks = data.countryData[country].tasks || [];
    const taskIndex = tasks.findIndex(t => t.id === taskId);
    if (taskIndex !== -1) {
        tasks.splice(taskIndex, 1);
        saveData(data);
        return res.json({ success: true });
    }

    // Try to delete from custom tasks
    const customTasks = data.countryData[country].customTasks || [];
    const customIndex = customTasks.findIndex(t => t.id === taskId);
    if (customIndex !== -1) {
        customTasks.splice(customIndex, 1);
        saveData(data);
        return res.json({ success: true });
    }

    res.status(404).json({ error: 'Task not found' });
});

// ADD new country
app.post('/api/country', (req, res) => {
    const data = loadData();
    const { code } = req.body;
    const countryCode = code.toUpperCase();

    if (data.countries.includes(countryCode)) {
        return res.status(400).json({ error: 'Country already exists' });
    }

    data.countries.push(countryCode);
    data.countryData[countryCode] = { tasks: [], customTasks: [] };
    
    // Initialize with default tasks
    data.defaultTasks.forEach((taskName, index) => {
        data.countryData[countryCode].tasks.push({
            id: `default-${index}`,
            name: taskName,
            done: false,
            assignee: "",
            notes: ""
        });
    });

    saveData(data);
    res.json({ success: true, country: countryCode });
});

// Store and get pending Slack notifications
const NOTIFICATIONS_FILE = path.join(__dirname, 'notifications.json');

function loadNotifications() {
    try {
        return JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf8'));
    } catch (e) {
        return { pending: [], sent: [] };
    }
}

function saveNotifications(data) {
    writeFileAtomic(NOTIFICATIONS_FILE, JSON.stringify(data, null, 2));
}

// Slack user IDs
const slackUsers = {
    'Dejan': 'U0A6L2WURD3',
    'Ajda': null,
    'Grega': null,
    'Petra': null,
    'Teja': null
};

const SLACK_TOKEN = process.env.SLACK_TOKEN || '';

// Send Slack message
async function sendSlackMessage(userId, text) {
    if (!userId) return { ok: false, error: 'No user ID' };
    
    const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${SLACK_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ channel: userId, text })
    });
    return response.json();
}

// POST notification (from frontend) - sends immediately
app.post('/api/notify', async (req, res) => {
    const { assignee, taskName, country, deadline, message, taskId } = req.body;
    const notifications = loadNotifications();
    
    const notification = {
        id: Date.now(),
        assignee,
        taskName,
        country,
        deadline,
        message,
        taskId,
        createdAt: new Date().toISOString()
    };
    
    // Try to send Slack message immediately
    const slackUserId = slackUsers[assignee];
    if (slackUserId) {
        const deadlineStr = deadline ? new Date(deadline).toLocaleDateString('sl-SI', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Ni določen';
        const slackText = `🚀 *Nova naloga: ${taskName}*\n\n📍 Država: ${country}\n📅 Rok: ${deadlineStr}\n\n📝 *Opis:*\n${message || 'Ni opisa'}\n\n✅ Ko končaš, označi tukaj: https://miki.noriks.com/launches/`;
        
        const result = await sendSlackMessage(slackUserId, slackText);
        notification.slackSent = result.ok;
        notification.slackError = result.error;
        
        if (result.ok) {
            notification.sentAt = new Date().toISOString();
            notifications.sent.push(notification);
        } else {
            notifications.pending.push(notification);
        }
    } else {
        notification.slackSent = false;
        notification.slackError = 'No Slack ID for user';
        notifications.pending.push(notification);
    }
    
    saveNotifications(notifications);
    res.json({ success: true, slackSent: notification.slackSent, error: notification.slackError });
});

// GET pending notifications (for agent to send)
app.get('/api/notifications/pending', (req, res) => {
    const notifications = loadNotifications();
    res.json(notifications.pending);
});

// Mark notification as sent
app.post('/api/notifications/:id/sent', (req, res) => {
    const notifications = loadNotifications();
    const id = parseInt(req.params.id);
    const index = notifications.pending.findIndex(n => n.id === id);
    
    if (index !== -1) {
        const [notification] = notifications.pending.splice(index, 1);
        notification.sentAt = new Date().toISOString();
        notifications.sent.push(notification);
        saveNotifications(notifications);
    }
    
    res.json({ success: true });
});

// Social Proof Generator
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const localNames = {
    hr: ['Marko Horvat', 'Ivan Kovačević', 'Ana Babić', 'Petra Jurić', 'Luka Novak', 'Maja Tomić', 'Filip Marić'],
    cz: ['Jakub Novák', 'Tomáš Svoboda', 'Martin Dvořák', 'Jana Černá', 'Lucie Procházková', 'Petr Kučera'],
    pl: ['Piotr Kowalski', 'Anna Nowak', 'Krzysztof Wiśniewski', 'Agnieszka Wójcik', 'Michał Kamiński', 'Magdalena Lewandowska'],
    gr: ['Νίκος Παπαδόπουλος', 'Μαρία Κωνσταντίνου', 'Γιώργος Αντωνίου', 'Ελένη Νικολάου', 'Δημήτρης Γεωργίου'],
    it: ['Marco Rossi', 'Giuseppe Russo', 'Francesca Bianchi', 'Alessandra Ferrari', 'Luca Esposito', 'Giulia Romano'],
    hu: ['Kovács Péter', 'Nagy Ágnes', 'Szabó Tamás', 'Tóth Katalin', 'Horváth Gábor', 'Varga Eszter'],
    sk: ['Ján Horváth', 'Peter Kováč', 'Mária Nagyová', 'Anna Szabová', 'Tomáš Baláž', 'Zuzana Tóthová']
};

const languages = {
    hr: 'Croatian', cz: 'Czech', pl: 'Polish', gr: 'Greek', it: 'Italian', hu: 'Hungarian', sk: 'Slovak'
};

const productNames = {
    hr: { boxers: 'boksericama', tshirt: 'majicom', set: 'kompletom' },
    cz: { boxers: 'boxerkami', tshirt: 'tričkem', set: 'setem' },
    pl: { boxers: 'bokserkami', tshirt: 'koszulką', set: 'zestawem' },
    gr: { boxers: 'μποξεράκια', tshirt: 'μπλούζα', set: 'σετ' },
    it: { boxers: 'boxer', tshirt: 'maglietta', set: 'set' },
    hu: { boxers: 'boxerrel', tshirt: 'pólóval', set: 'szettel' },
    sk: { boxers: 'boxerkami', tshirt: 'tričkom', set: 'setom' },
    si: { boxers: 'boksaricami', tshirt: 'majico', set: 'kompletom' },
    ro: { boxers: 'boxeri', tshirt: 'tricou', set: 'set' }
};

app.post('/api/social-proof/generate', async (req, res) => {
    const { country, style, product, praiseType } = req.body;
    
    const lang = languages[country] || 'English';
    const names = localNames[country] || localNames.hr;
    const name = names[Math.floor(Math.random() * names.length)];
    
    const actualProduct = product === 'any' 
        ? ['boxers', 'tshirt', 'set'][Math.floor(Math.random() * 3)]
        : product;
    
    const actualPraise = praiseType === 'any'
        ? ['quality', 'delivery', 'support', 'price'][Math.floor(Math.random() * 4)]
        : praiseType;
    
    const praiseDescriptions = {
        quality: 'amazing product quality, comfortable material, perfect fit',
        delivery: 'super fast delivery, great packaging',
        support: 'excellent customer support, quick responses',
        price: 'great value for money, affordable premium quality'
    };
    
    const prompt = `Write a short, authentic customer review in ${lang} language for NORIKS underwear/clothing brand.
The review should praise: ${praiseDescriptions[actualPraise]}
Product: ${actualProduct === 'boxers' ? 'boxer shorts' : actualProduct === 'tshirt' ? 't-shirt' : 'underwear set'}
Style: casual, genuine, like a real customer wrote it. NOT too formal, NOT marketing speak.
Length: 3-4 sentences.
DO NOT include greetings, sign-offs, or title.
Write ONLY the review body text in ${lang}, nothing else.`;

    const titlePrompt = `Write a short, enthusiastic review title (4-6 words max) in ${lang} language about NORIKS ${actualProduct === 'boxers' ? 'boxer shorts' : actualProduct === 'tshirt' ? 't-shirt' : 'underwear set'}.
Style: casual but excited, like "NORIKS boxers are the best!" or "Super comfortable!"
Write ONLY the title in ${lang}, nothing else.`;

    try {
        // Generate both text and title in parallel
        const [textResponse, titleResponse] = await Promise.all([
            fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 250,
                    temperature: 0.9
                })
            }),
            fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [{ role: 'user', content: titlePrompt }],
                    max_tokens: 50,
                    temperature: 0.9
                })
            })
        ]);
        
        const textData = await textResponse.json();
        const titleData = await titleResponse.json();
        
        if (textData.error) {
            return res.status(500).json({ error: textData.error.message });
        }
        
        const text = textData.choices[0].message.content.trim();
        const title = titleData.choices?.[0]?.message?.content?.trim() || 'Odlično!';
        
        // Generate random date in last 30 days
        const daysAgo = Math.floor(Math.random() * 30) + 1;
        const date = new Date();
        date.setDate(date.getDate() - daysAgo);
        const dateStr = date.toLocaleDateString(country === 'gr' ? 'el-GR' : `${country}-${country.toUpperCase()}`, { 
            day: 'numeric', month: 'short', year: 'numeric' 
        });
        
        res.json({
            text,
            title,
            name,
            date: dateStr,
            stars: Math.random() > 0.3 ? 5 : 4,
            country,
            product: actualProduct,
            praiseType: actualPraise
        });
        
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Generate review for Social Proof Generator (frontend calls this)
app.post('/api/generate-review', async (req, res) => {
    const { country, product, praise, stars, style, isGift } = req.body;
    
    const lang = languages[country.toLowerCase()] || 'English';
    
    const productMap = {
        boxers: { en: 'boxer shorts', hr: 'boksarice', cz: 'boxerky', pl: 'bokserki', gr: 'μποξεράκια', it: 'boxer', hu: 'boxer', sk: 'boxerky' },
        tshirt: { en: 't-shirt', hr: 'majica', cz: 'tričko', pl: 'koszulka', gr: 'μπλούζα', it: 'maglietta', hu: 'póló', sk: 'tričko' },
        set: { en: 'underwear set', hr: 'komplet', cz: 'set', pl: 'zestaw', gr: 'σετ', it: 'set', hu: 'szett', sk: 'set' }
    };
    
    const praiseMap = {
        quality: 'amazing product quality, soft comfortable material, perfect fit that stays in place',
        delivery: 'super fast delivery, excellent packaging, arrived quickly',
        support: 'excellent customer support, quick helpful responses, great communication',
        value: 'great value for money, affordable yet premium quality, worth every penny',
        comfort: 'incredibly comfortable, feels like wearing nothing, perfect all-day comfort',
        durability: 'very durable, keeps shape and color after many washes, long-lasting quality',
        gift: 'bought as gift for partner/husband, they absolutely love it, great gift idea'
    };
    
    const productName = productMap[product]?.en || 'underwear';
    const praiseFocus = praiseMap[praise] || praiseMap.quality;
    
    const isFacebook = style === 'facebook';
    
    // Gender context for the review
    const genderContext = isGift 
        ? 'The reviewer is a WOMAN who bought this as a gift for her boyfriend/husband. She talks about how HE loves it.'
        : 'The reviewer is a MAN who bought this for himself. He talks about his own experience wearing it.';
    
    const prompt = isFacebook 
        ? `Write an authentic Facebook comment in ${lang} language praising NORIKS brand ${productName}.

${genderContext}

The comment should emphasize: ${praiseFocus}

Requirements:
- Write like a REAL Facebook comment, casual and conversational
- 2-3 sentences maximum (short comment style)
- Can compare to other brands (without naming them) like "other boxers always..."
- NO hashtags, NO emojis, NO formal language
- Mention NORIKS brand name naturally
- Sound like native ${lang} speaker
- Use correct grammatical gender for the reviewer

Return ONLY the comment text in ${lang}, no quotes.`
        : `Write an authentic short customer review in ${lang} language for NORIKS brand ${productName}.

${genderContext}

The review should emphasize: ${praiseFocus}

Requirements:
- Write like a REAL customer, casual and genuine
- 3-4 sentences maximum
- NO marketing speak, NO formal language
- Mention NORIKS brand naturally
- Sound like native ${lang} speaker
- Use correct grammatical gender for the reviewer
- ${stars === 4 ? 'Slightly less enthusiastic but still positive' : 'Very satisfied customer'}

Return ONLY the review text, no quotes, no translation, just the ${lang} text.`;

    const titlePrompt = `Write a short catchy review title (3-6 words) in ${lang} language for a ${productName} review.

Examples style: "Best purchase ever!", "Finally found the one", "Super comfortable!"

Write ONLY the title in ${lang}, no quotes.`;

    try {
        // For Facebook style, skip title generation
        const requests = [
            fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 300,
                    temperature: 0.85
                })
            })
        ];
        
        // Only add title request for Trustpilot style
        if (!isFacebook) {
            requests.push(
                fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${OPENAI_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: 'gpt-4o-mini',
                        messages: [{ role: 'user', content: titlePrompt }],
                        max_tokens: 50,
                        temperature: 0.85
                    })
                })
            );
        }
        
        const results = await Promise.all(requests);
        const textData = await results[0].json();
        const titleData = results[1] ? await results[1].json() : null;
        
        if (textData.error) {
            console.error('OpenAI error:', textData.error);
            return res.status(500).json({ error: textData.error.message });
        }
        
        const body = textData.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
        const title = titleData?.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, '') || null;
        
        res.json({ title, body });
        
    } catch (err) {
        console.error('Generate review error:', err);
        res.status(500).json({ error: err.message });
    }
});

// [FAZA2] Metakocka poverilnici iz .env. Ce manjkata, GLASNO opozori (sync ne bo delal).
const METAKOCKA_COMPANY_ID = parseInt(process.env.METAKOCKA_COMPANY_ID || '0', 10);
const METAKOCKA_SECRET = process.env.METAKOCKA_SECRET || '';
if (!METAKOCKA_SECRET || !METAKOCKA_COMPANY_ID) {
    console.error('[FATAL-CONFIG] METAKOCKA_SECRET/COMPANY_ID manjka v .env — Metakocka sync NE BO deloval!');
}

// Meta Ads API
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || 'EAAR1d7hDpEkBQs1YPhRZBgu4UZA8DLZBWzXXTItG3NL8LdpRmdhQ3nh1DHW0ZCfpOz25qT0n5Ca0PzrTcRtw1tHYZBATVMZCqn0rjrnUgZCYk6U57ZBisv0vpLLL9lIIn51bk7n5ISZBXdPTIDovAFHghGOsInJoqhvqQaWmey3qJByEiRTfcrWF3EsXYNZAm5yaRYL4y94n9H';
const META_AD_ACCOUNT = process.env.META_AD_ACCOUNT || 'act_1922887421998222';

// VAT rates by country code
const VAT_RATES = {
    'SI': 0.22, 'HR': 0.25, 'CZ': 0.21, 'PL': 0.23,
    'GR': 0.24, 'IT': 0.22, 'HU': 0.27, 'SK': 0.20, 'DE': 0.19
};

// Map WooCommerce country to our codes
const COUNTRY_MAP = {
    'Slovenia': 'SI', 'Slovenija': 'SI', 'SI': 'SI',
    'Croatia': 'HR', 'Hrvaška': 'HR', 'HR': 'HR',
    'Czech Republic': 'CZ', 'Czechia': 'CZ', 'Česka': 'CZ', 'CZ': 'CZ',
    'Poland': 'PL', 'Poljska': 'PL', 'PL': 'PL',
    'Greece': 'GR', 'Grčija': 'GR', 'GR': 'GR',
    'Italy': 'IT', 'Italija': 'IT', 'IT': 'IT',
    'Hungary': 'HU', 'Madžarska': 'HU', 'HU': 'HU',
    'Slovakia': 'SK', 'Slovaška': 'SK', 'SK': 'SK',
    'Germany': 'DE', 'Nemčija': 'DE', 'Deutschland': 'DE', 'DE': 'DE',
    'English': 'EN', 'International': 'EN', 'EN': 'EN'
};

// Get finance summary from Metakocka
app.get('/api/finance/summary', async (req, res) => {
    const period = req.query.period || '2026-02'; // YYYY-MM format
    const [year, month] = period.split('-');
    
    try {
        // Calculate date range
        const startDate = `${year}-${month}-01`;
        const endDate = new Date(year, parseInt(month), 0).toISOString().split('T')[0];
        
        // Try Metakocka API
        let orders = [];
        try {
            const metakockaResponse = await fetch('https://main.metakocka.si/rest/eshop/v1/json/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    secret_key: METAKOCKA_SECRET,
                    company_id: METAKOCKA_COMPANY_ID,
                    doc_type: 'sales_order',
                    query_advance: [
                        { type: 'date', field: 'doc_date', from: startDate, to: endDate }
                    ],
                    limit: 1000,
                    offset: 0
                })
            });
            
            const responseText = await metakockaResponse.text();
            
            // Check if response is JSON
            if (responseText.trim().startsWith('{') || responseText.trim().startsWith('[')) {
                const data = JSON.parse(responseText);
                if (!data.error && data.result) {
                    orders = data.result || [];
                } else if (data.error) {
                    console.log('Metakocka returned error:', data.error);
                }
            } else {
                console.log('Metakocka returned non-JSON response');
            }
        } catch (mkErr) {
            console.log('Metakocka API failed, using manual data:', mkErr.message);
        }
        
        // If no orders from API, return sample structure for manual entry
        if (orders.length === 0) {
            // Return empty structure - data will be entered manually
            return res.json({ 
                pending: { total: 0, count: 0, byCountry: {} },
                received: { total: 0, count: 0, byCountry: {} },
                period: { start: startDate, end: endDate },
                source: 'manual'
            });
        }
        
        // Process orders
        const pending = { total: 0, count: 0, byCountry: {} };
        const received = { total: 0, count: 0, byCountry: {} };
        
        for (const order of orders) {
            const amount = parseFloat(order.doc_total || order.total || 0);
            const country = COUNTRY_MAP[order.partner_country || order.country || 'SI'] || 'SI';
            const isPaid = order.status === 'paid' || order.payment_status === 'paid' || order.doc_status === 'closed';
            
            const target = isPaid ? received : pending;
            target.total += amount;
            target.count++;
            
            if (!target.byCountry[country]) {
                target.byCountry[country] = { amount: 0, count: 0, vat: 0 };
            }
            target.byCountry[country].amount += amount;
            target.byCountry[country].count++;
            
            // Calculate VAT
            const vatRate = VAT_RATES[country] || 0.22;
            target.byCountry[country].vat += amount * vatRate / (1 + vatRate);
        }
        
        res.json({ pending, received, period: { start: startDate, end: endDate }, source: 'metakocka' });
        
    } catch (err) {
        console.error('Finance API error:', err);
        res.json({ 
            pending: { total: 0, count: 0, byCountry: {} },
            received: { total: 0, count: 0, byCountry: {} },
            error: err.message,
            source: 'error'
        });
    }
});

// Get Facebook Ads spend
app.get('/api/finance/fb-spend', async (req, res) => {
    const period = req.query.period || '2026-02';
    const [year, month] = period.split('-');
    
    try {
        const startDate = `${year}-${month}-01`;
        const lastDay = new Date(year, parseInt(month), 0).getDate();
        const endDate = `${year}-${month}-${lastDay.toString().padStart(2, '0')}`;
        
        const url = `https://graph.facebook.com/v21.0/${META_AD_ACCOUNT}/insights?` + 
            `access_token=${META_ACCESS_TOKEN}&` +
            `fields=spend&` +
            `time_range={"since":"${startDate}","until":"${endDate}"}&` +
            `level=account`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.error) {
            console.error('Meta API error:', data.error);
            return res.json({ error: data.error.message, spend: 0 });
        }
        
        const spend = data.data && data.data[0] ? parseFloat(data.data[0].spend) : 0;
        
        res.json({ spend, period: { start: startDate, end: endDate } });
        
    } catch (err) {
        console.error('FB Spend API error:', err);
        res.json({ error: err.message, spend: 0 });
    }
});

// Get daily orders from Metakocka
app.get('/api/finance/daily-orders', async (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    
    try {
        const response = await fetch('https://main.metakocka.si/rest/eshop/v1/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                secret_key: METAKOCKA_SECRET,
                company_id: METAKOCKA_COMPANY_ID,
                doc_type: 'sales_order',
                result_type: 'doc',
                limit: 100,
                return_delivery_service_events: true,
                query_advance: [
                    { type: 'doc_date_from', value: date + '+02:00' },
                    { type: 'doc_date_to', value: date + '+02:00' }
                ]
            })
        });
        
        const data = await response.json();
        
        if (data.opr_code !== '0') {
            return res.json({ error: data.opr_desc || 'Metakocka error' });
        }
        
        const orders = data.result || [];
        const summary = {
            date,
            total_orders: orders.length,
            cod_orders: 0,
            online_orders: 0,
            total_revenue: 0,
            cod_revenue: 0,
            online_revenue: 0,
            by_country: {},
            by_status: {},
            pending_cod: { count: 0, amount: 0 },
            delivered_cod: { count: 0, amount: 0 },
            rejected: { count: 0, amount: 0 }
        };
        
        for (const order of orders) {
            const amount = parseFloat(order.sum_all) || 0;
            const country = order.partner?.country_iso_2 || 'SI';
            const status = order.status_code || 'Unknown';
            const isCOD = order.method_of_payment === 'Po povzetju';
            const isPaid = !!order.sum_paid;
            
            // Track by country
            if (!summary.by_country[country]) {
                summary.by_country[country] = { orders: 0, revenue: 0, cod: 0, online: 0 };
            }
            summary.by_country[country].orders++;
            summary.by_country[country].revenue += amount;
            
            // Track by status
            summary.by_status[status] = (summary.by_status[status] || 0) + 1;
            
            // Track COD vs Online
            if (isCOD) {
                summary.cod_orders++;
                summary.cod_revenue += amount;
                summary.by_country[country].cod++;
                
                // Check delivery events for COD status
                const events = order.delivery_service_events || [];
                const eventTexts = events.map(e => e.event_status?.toLowerCase() || '');
                
                const isDelivered = eventTexts.some(e => 
                    e.includes('isporucena primatelju') || 
                    e.includes('delivered') ||
                    e.includes('predana u paketomat')
                );
                const isRejected = eventTexts.some(e => 
                    e.includes('neuruciva') || 
                    e.includes('povrat') ||
                    e.includes('rejected') ||
                    e.includes('return')
                );
                
                if (isRejected) {
                    summary.rejected.count++;
                    summary.rejected.amount += amount;
                } else if (isPaid || isDelivered) {
                    summary.delivered_cod.count++;
                    summary.delivered_cod.amount += amount;
                } else {
                    summary.pending_cod.count++;
                    summary.pending_cod.amount += amount;
                }
            } else {
                summary.online_orders++;
                summary.online_revenue += amount;
                summary.by_country[country].online++;
            }
            
            summary.total_revenue += amount;
        }
        
        res.json(summary);
        
    } catch (err) {
        console.error('Daily orders API error:', err);
        res.json({ error: err.message });
    }
});

// Get all pending COD (shipped but not yet received)
app.get('/api/finance/pending-cod', async (req, res) => {
    try {
        // Get recent shipped orders
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        
        const response = await fetch('https://main.metakocka.si/rest/eshop/v1/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                secret_key: METAKOCKA_SECRET,
                company_id: METAKOCKA_COMPANY_ID,
                doc_type: 'sales_order',
                result_type: 'doc',
                limit: 100,
                return_delivery_service_events: true,
                query_advance: [
                    { type: 'doc_date_from', value: thirtyDaysAgo + '+02:00' }
                ]
            })
        });
        
        const data = await response.json();
        
        if (data.opr_code !== '0') {
            return res.json({ error: data.opr_desc, total: 0, count: 0, byCountry: {} });
        }
        
        const orders = data.result || [];
        let total = 0;
        let count = 0;
        const byCountry = {};
        const byDate = {};
        
        for (const order of orders) {
            const isCOD = order.method_of_payment === 'Po povzetju';
            const isPaid = !!order.sum_paid;
            const status = order.status_code;
            
            // Only count shipped COD orders that are not paid/rejected
            if (!isCOD || isPaid || status === 'Brisan') continue;
            
            const events = order.delivery_service_events || [];
            const eventTexts = events.map(e => e.event_status?.toLowerCase() || '');
            
            const isDelivered = eventTexts.some(e => 
                e.includes('isporucena primatelju') || 
                e.includes('delivered') ||
                e.includes('predana u paketomat')
            );
            const isRejected = eventTexts.some(e => 
                e.includes('neuruciva') || 
                e.includes('povrat') ||
                e.includes('return')
            );
            
            // Skip delivered or rejected
            if (isDelivered || isRejected) continue;
            
            const amount = parseFloat(order.sum_all) || 0;
            const country = order.partner?.country_iso_2 || 'SI';
            const orderDate = order.doc_date?.split('+')[0] || 'unknown';
            
            total += amount;
            count++;
            
            if (!byCountry[country]) {
                byCountry[country] = { amount: 0, count: 0 };
            }
            byCountry[country].amount += amount;
            byCountry[country].count++;
            
            if (!byDate[orderDate]) {
                byDate[orderDate] = { amount: 0, count: 0 };
            }
            byDate[orderDate].amount += amount;
            byDate[orderDate].count++;
        }
        
        res.json({ total: Math.round(total * 100) / 100, count, byCountry, byDate });
        
    } catch (err) {
        console.error('Pending COD API error:', err);
        res.json({ total: 0, count: 0, error: err.message });
    }
});

// Save/load fixed costs
const FIXED_COSTS_FILE = path.join(__dirname, 'data', 'fixed-costs.json');

app.get('/api/finance/fixed-costs', (req, res) => {
    try {
        if (fs.existsSync(FIXED_COSTS_FILE)) {
            const data = JSON.parse(fs.readFileSync(FIXED_COSTS_FILE, 'utf8'));
            res.json(data);
        } else {
            res.json([]);
        }
    } catch (err) {
        res.json({ error: err.message });
    }
});

app.post('/api/finance/fixed-costs', (req, res) => {
    try {
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        
        writeFileAtomic(FIXED_COSTS_FILE, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch (err) {
        res.json({ error: err.message });
    }
});

// ============ END FINANCE API ============

// ============ PACKING API ============
// Uses existing METAKOCKA_COMPANY_ID and METAKOCKA_SECRET from line ~2774

// WooCommerce enrichment for ORTO orders missing doc_desc
// Fetches meta_data from WC to get actual color/size info
async function enrichOrtoOrdersFromWC(orders) {
    // Find orders that have ORTO products with "Ni podatka"
    const ordersToEnrich = orders.filter(o => {
        if (!o._wcRef || !o._eshop) return false;
        // (a) ORTO brez doc_desc — kot doslej.
        const hasOrtoMissing = (o._rawProducts || []).some(p => {
            const code = (p.code || '').toUpperCase();
            return code.includes('ORTO') && !p.doc_desc;
        });
        // (b) [2026-08-26 Dejan] KARKOLI, cesar iz Metakocke nismo znali razcleniti.
        //     Metakocka je samo posrednik — izvorni podatek (velikost, barva, kolicina)
        //     je vedno v WooCommerce in do njega imamo dostop prek stevilke narocila.
        //     Zato ne ugibamo in ne pustimo opozorila, dokler nismo vprasali izvora.
        const neresolveno = (o.products || []).some(pr =>
            (pr.items || []).some(i => (i.warnings && i.warnings.length) ||
                                       i.color === 'Ni podatka' || i.size === 'Ni podatka'));
        return hasOrtoMissing || neresolveno;
    });
    
    if (ordersToEnrich.length === 0) return;
    console.log(`[Packing] Enriching ${ordersToEnrich.length} ORTO orders from WooCommerce`);
    
    // Map eshop_name to store key (e.g. "noriks.com/hr" → "hr")
    function getStoreKey(eshopName) {
        const e = (eshopName || '').trim();
        // EN / global store has no country prefix
        if (e === 'noriks.com') return 'en';
        const match = e.match(/noriks\.com\/(\w+)/);
        return match ? match[1] : null;
    }
    
    // Parse WC order ID from title (e.g. "NORIKS-HR-5779" → 5779)
    function getWcOrderId(wcRef) {
        const match = (wcRef || '').match(/(\d+)$/);
        return match ? match[1] : null;
    }
    
    // Color translation for WC meta values (Croatian and other languages)
    const wcColorMap = {
        'crna': 'Črna', 'crno': 'Črna', 'černá': 'Črna', 'czarna': 'Črna', 'fekete': 'Črna', 'nero': 'Črna', 'μαύρο': 'Črna', 'black': 'Črna', 'schwarz': 'Črna',
        'bijela': 'Bela', 'bela': 'Bela', 'biela': 'Bela', 'biała': 'Bela', 'fehér': 'Bela', 'bianco': 'Bela', 'λευκό': 'Bela', 'white': 'Bela', 'weiß': 'Bela', 'weiss': 'Bela',
        'siva': 'Siva', 'šedá': 'Siva', 'szürke': 'Siva', 'szara': 'Siva', 'grigio': 'Siva', 'γκρι': 'Siva', 'grey': 'Siva', 'gray': 'Siva', 'grau': 'Siva',
        'zelena': 'Zelena', 'zelená': 'Zelena', 'zielona': 'Zelena', 'zöld': 'Zelena', 'verde': 'Zelena', 'πράσινο': 'Zelena', 'green': 'Zelena', 'grün': 'Zelena',
        'modra': 'Modra', 'modrá': 'Modra', 'niebieska': 'Modra', 'kék': 'Modra', 'blu': 'Modra', 'μπλε': 'Modra', 'blue': 'Modra', 'blau': 'Modra',
        'rdeča': 'Rdeča', 'crvena': 'Rdeča', 'červená': 'Rdeča', 'czerwona': 'Rdeča', 'piros': 'Rdeča', 'rosso': 'Rdeča', 'κόκκινο': 'Rdeča', 'red': 'Rdeča', 'rot': 'Rdeča',
        'rjava': 'Rjava', 'smeđa': 'Rjava', 'hnědá': 'Rjava', 'brązowa': 'Rjava', 'barna': 'Rjava', 'marrone': 'Rjava', 'καφέ': 'Rjava', 'brown': 'Rjava', 'braun': 'Rjava',
        'bež': 'Bež', 'bežová': 'Bež', 'beżowa': 'Bež', 'bézs': 'Bež', 'beige': 'Bež', 'μπεζ': 'Bež',
        'tamno modra': 'Temno modra', 'tamnoplava': 'Temno modra', 'tamno plava': 'Temno modra', 'dark blue': 'Temno modra', 'σκούρο μπλε': 'Temno modra', 'dunkelblau': 'Temno modra',
        'roza': 'Roza', 'pink': 'Roza', 'ροζ': 'Roza', 'rosa': 'Roza',
    };
    
    // Type translation for WC meta values
    const wcTypeMap = {
        'majica': 'Majica', 'tričko': 'Majica', 'koszulka': 'Majica', 'póló': 'Majica', 'maglietta': 'Majica', 'μπλούζα': 'Majica', 'shirt': 'Majica', 't-shirt': 'Majica',
        'bokserica': 'Boksarice', 'boksarice': 'Boksarice', 'boxerky': 'Boksarice', 'bokserki': 'Boksarice', 'boxer': 'Boksarice', 'μπόξερ': 'Boksarice',
        'nogavice': 'Nogavice', 'ponožky': 'Nogavice', 'skarpetki': 'Nogavice', 'zokni': 'Nogavice', 'calzini': 'Nogavice', 'κάλτσες': 'Nogavice', 'șosete': 'Nogavice', 'sosete': 'Nogavice',
        // Romanian
        'tricou': 'Majica', 'tricouri': 'Majica', 'boxeri': 'Boksarice', 'chiloți': 'Boksarice', 'chiloti': 'Boksarice',
        // German
        'unterhemd': 'Majica', 'unterhose': 'Boksarice', 'socken': 'Nogavice',
    };
    
    function translateWcColor(raw) {
        const lower = (raw || '').trim().toLowerCase();
        if (wcColorMap[lower]) return wcColorMap[lower];
        // [2026-08-26 Dejan] Ta slovar je krajsi od glavnega in ni poznal moskih
        // oblik ("czarny", "zielony", "granatowy") — te so kot barva koncale na
        // kartici surove, brez opozorila, ker enrichment postavke oznaci kot urejene.
        // Zato pademo na GLAVNI prevajalnik, ki pozna sklone in vse trge.
        const glavni = translateColorServer(raw);
        return glavni || raw.trim();
    }
    
    function translateWcType(raw) {
        const lower = (raw || '').trim().toLowerCase().replace(/\s*\d+$/, ''); // remove trailing number like "Μπλούζα 1"
        return wcTypeMap[lower] || raw.trim();
    }
    
    // Parse WC meta value like "Majica: Zelena - 2XL" or "Bokserica: Crna - 2XL"
    function parseWcMetaValue(value, sku) {
        // Pattern: "Type: Color - Size"
        const match = (value || '').match(/^([^:]+):\s*([^-]+)\s*-\s*(\S+)$/);
        if (match) {
            return {
                type: translateWcType(match[1]),
                color: translateWcColor(match[2]),
                size: match[3].trim().toUpperCase()
            };
        }
        // Fallback: "Color - Size" brez Type prefiksa (npr. HU "Fekete - XL", SI "Črna - M")
        // — type izpeljemo iz SKU (SHIRTS-ORTO -> Majica, BOXERS-ORTO -> Boksarice)
        const m2 = (value || '').match(/^([^-]+?)\s*-\s*(\S+)$/);
        if (m2) {
            const s = (sku || '').toUpperCase();
            const type = s.includes('BOXER') ? 'Boksarice' : (s.includes('SOCK') || s.includes('NOGAVIC')) ? 'Nogavice' : 'Majica';
            return {
                type,
                color: translateWcColor(m2[1]),
                size: m2[2].trim().toUpperCase()
            };
        }
        return null;
    }
    
    // Fetch and enrich in parallel
    const enrichPromises = ordersToEnrich.map(async (order) => {
        const storeKey = getStoreKey(order._eshop);
        const wcOrderId = getWcOrderId(order._wcRef);
        if (!storeKey || !wcOrderId || !wcStores[storeKey]) {
            console.log(`[Packing WC] Cannot enrich order ${order.id}: store=${storeKey} wcId=${wcOrderId}`);
            return;
        }
        
        const store = wcStores[storeKey];
        try {
            const wcRes = await fetch(`${store.url}/wp-json/wc/v3/orders/${wcOrderId}?consumer_key=${store.ck}&consumer_secret=${store.cs}`);
            if (!wcRes.ok) {
                console.log(`[Packing WC] Failed to fetch WC order ${wcOrderId} from ${storeKey}: ${wcRes.status}`);
                return;
            }
            const wcOrder = await wcRes.json();
            
            // Update total from WC if missing
            if (!order.total || order.total === '0' || order.total === '0.00') {
                order.total = wcOrder.total || order.total;
            }
            
            // Parse WC line items for product details
            const wcItems = [];
            const wcBySku = new Map();   // [2026-08-26] da podatke pripnemo PRAVI postavki
            const dodaj = (sku, arr) => {
                if (!arr || !arr.length) return;
                wcItems.push(...arr);
                const k = String(sku || '').toUpperCase();
                if (!wcBySku.has(k)) wcBySku.set(k, []);
                wcBySku.get(k).push(...arr);
            };
            for (const lineItem of (wcOrder.line_items || [])) {
                const sku = (lineItem.sku || '').toUpperCase();
                const metaData = lineItem.meta_data || [];
                const kolicina = parseInt(lineItem.quantity) || 1;
                
                // Strategy 1: ORTO products — parse numeric meta keys ("1": "Majica: Zelena - 2XL")
                if (sku.includes('ORTO')) {
                    const zbrani = [];
                    for (const meta of metaData) {
                        if (!/^\d+$/.test(meta.key)) continue;
                        const parsed = parseWcMetaValue(meta.value, sku);
                        if (parsed) zbrani.push(parsed);
                    }
                    dodaj(sku, zbrani);
                    continue;
                }
                
                // Strategy 2: Bundle products — reconstruct doc_desc from meta and run through parseDocDesc
                // Build a doc_desc string from WC meta (e.g. "velicina-majice: L velicina-bokseric: XL")
                const descParts = metaData
                    .filter(m => !m.key.startsWith('_'))
                    .map(m => `${m.key} : ${m.value}`);
                const syntheticDocDesc = descParts.join(' ');
                if (syntheticDocDesc) {
                    const parsedBundle = parseDocDesc(syntheticDocDesc, sku, lineItem.name || '');
                    if (parsedBundle.length > 0 && !parsedBundle.every(i => i.color === 'Ni podatka')
                        && parsedBundle.every(i => i.size || i.color)) {
                        dodaj(sku, parsedBundle);
                        continue;
                    }
                }

                // Strategija 3 [2026-08-26 Dejan]: SPLOSNO. Ce zgornji dve ne uspeta,
                // preberemo velikost in barvo naravnost iz meta polj WooCommerca po
                // pomenu kljuca (vsi trgi imajo svoje ime za "velikost" in "barva").
                // S tem pokrijemo izdelke, pri katerih je doc_desc v Metakocki prazen.
                const KLJUC_VEL = /^(velicina|veličina|velikost|veľkost|velkost|rozmiar|marime|mărime|meret|méret|megethos|μέγεθος|groesse|größe|grosse|taglia|size)/i;
                const KLJUC_BARVA = /^(boja|barva|kolor|culoare|szin|szín|color|colour|farbe|colore|χρώμα|chroma|barwa)/i;
                let gVel = '', gBarva = '';
                for (const meta of metaData) {
                    const k = String(meta.key || '').trim();
                    if (k.startsWith('_')) continue;
                    const v = String(meta.value || '').trim();
                    if (!v) continue;
                    if (!gVel && KLJUC_VEL.test(k)) gVel = v.toUpperCase();
                    else if (!gBarva && KLJUC_BARVA.test(k)) gBarva = translateWcColor(v);
                }
                // barvo sprejmemo samo, ce jo RES prepoznamo — sicer bi ime paketa
                // ("tonuri", "každodenní") koncalo v polju za barvo in skladisce bi
                // videlo smiselno videti, a napacen podatek.
                const ZNANA_BARVA = /^(Črna|Bela|Siva|Zelena|Modra|Rdeča|Rjava|Bež|Roza|Oranžna|Vijolična|Rumena|Turkizna|Temno modra|Svetlo modra|Črna & Bela)$/;
                if (gBarva && !ZNANA_BARVA.test(gBarva)) gBarva = '';
                if (gVel || gBarva) {
                    const tip = sku.includes('BOXER') ? 'Boksarice'
                              : (sku.includes('SOCK') || sku.includes('KOMZIPS')) ? 'Nogavice'
                              : translateWcType(String(lineItem.name || '').split(/[|:]/)[0] || '') || 'Izdelek';
                    dodaj(sku, Array(kolicina).fill(null).map(() => ({ type: tip, color: gBarva, size: gVel })));
                }
            }
            
            if (wcItems.length === 0) {
                console.log(`[Packing WC] No items parsed from WC order ${wcOrderId}`);
                return;
            }
            
            console.log(`[Packing WC] Enriched order ${order.id} with ${wcItems.length} items from WC ${storeKey}/${wcOrderId}`);
            
            // [2026-08-26 Dejan] Zamenjamo SAMO postavke, ki jim podatek manjka, in to
            // s podatki ISTE sifre. Prej se je cel paket povozil z vsemi vrsticami iz
            // WooCommerca — pri narocilu z vec izdelki je to podvajalo kose.
            for (const product of order.products) {
                if (!product.items) continue;
                const potrebuje = product.items.some(i => (i.warnings && i.warnings.length) ||
                                                          i.color === 'Ni podatka' || i.size === 'Ni podatka');
                if (!potrebuje) continue;

                let zamenjava = wcBySku.get(String(product.code || '').toUpperCase());
                // ce sifre ne najdemo, smemo vzeti vse SAMO kadar je v narocilu en sam izdelek
                if ((!zamenjava || !zamenjava.length) && order.products.length === 1) zamenjava = wcItems;
                if (!zamenjava || !zamenjava.length) continue;

                product.items = zamenjava.map(item => {
                    const cist = { ...item };
                    delete cist.warnings;          // podatek imamo — opozorilo ni vec upraviceno
                    cist.noWarning = true;
                    return cist;
                });
                product.label = product.label.replace(/\(\d+ kos\)/, `(${zamenjava.length} kos)`);
            }
            // Update flat items too
            order.items = order.products.map(p => p.items || p);
            
        } catch (e) {
            console.error(`[Packing WC] Error enriching order ${order.id}:`, e.message);
        }
    });
    
    await Promise.all(enrichPromises);
}

// Get packing orders from Metakocka
const _packingInflight = new Map(); // key -> ts; dedup pocasnih Metakocka fetchev
app.get('/api/packing/orders', async (req, res) => {
    const { status = 'Odpremljen', date, limit = 500 } = req.query;
    // _bg=1 oznaci background warmup klic: edini sme cakati dolgo na Metakocko.
    const isBg = req.query._bg === '1';

    // [2026-08-14 Dejan] TOPSELLERS rabi 14-dnevno okno, packing zavihek pa OSTANE na 5 dneh.
    // KLJUCNO: cache key MORA vsebovati dolzino okna, sicer bi si strani povozili podatke
    // (packing bi dobil 14d podatke ali obratno). Privzeta pot ('last3d' key) ostane NESPREMENJENA.
    const _daysReq = parseInt(req.query.days, 10);
    const _days = Math.min(_daysReq > 0 ? _daysReq : PACKING_DAYS_DEFAULT, PACKING_DAYS_MAX);
    const isLongWindow = !date && _days !== PACKING_DAYS_DEFAULT;
    const _datePart = date || (isLongWindow ? `last${_days}d` : 'last3d');
    // Daljse okno se osvezuje redkeje (manjsa obremenitev Metakocke) — uporabnik dobi
    // takoj cache, osvezitev pa stece v ozadju (stale-while-revalidate).
    const _freshMs = isLongWindow ? PACKING_CACHE_FRESH_LONG_MS : PACKING_CACHE_FRESH_MS;

    try {
        // [2026-08-14 Dejan] DOLGO OKNO (topsellers) se postreze IZ KOTALECEGA SKLADISCA —
        // uporabnik NIKOLI ne caka na Metakocko. Skladisce se polni iz rednih 5-dnevnih
        // sync-ov (vsakih ~5 min) + nocnega polnega 14-dnevnega fetcha ob 04:00.
        if (isLongWindow && !isBg) {
            const out = tsdb.getOrders({ days: _days, status: status || null, limit: parseInt(limit) || 20000 });
            const cov = tsdb.coverage(_days);
            // Uporabnikov obisk NE sproza polnega 14-dnevnega fetcha — samo redno vzdrzevanje
            // (doplacilo manjkajocih dni oz. polni backfill z 24h varovalko).
            if (cov.missing.length) setImmediate(() => { try { maintainRolling().catch(() => {}); } catch (_) {} });
            return res.json({
                orders: out, count: out.length, db: true,
                coverageFrom: cov.oldest, days: Object.keys(cov.byDay).length,
                missingDays: cov.missing, totalInDb: cov.total,
                lastFullSync: tsdb.getMeta('lastFullSync'), lastDayRefresh: tsdb.getMeta('lastDayRefresh')
            });
        }

        // STALE-WHILE-REVALIDATE: uporabniski request NIKOLI ne caka na Metakocko,
        // ce obstaja KAKRSENKOLI cache. Svez (<5 min) -> cached, starejsi -> stale takoj
        // + sproZi background warmup. Edino background warmup (_bg=1) gre naprej do fetcha.
        try {
            const fastKey = `orders_${status || 'all'}_${_datePart}`;
            const entry = tsdb.cacheGet(fastKey);   // [FAZA3.2] en kljuc, ne cel 4MB cache
            // [2026-08-14] force=1 (samo background backfill): preskoci cache-short-circuit,
            // sicer se backfill vrne iz svezega cache-a in skladisce se NIKOLI ne napolni.
            const forceFetch = isBg && req.query.force === '1';
            if (entry && entry.orders && entry.cachedAt && !forceFetch) {
                const ageMs = Date.now() - new Date(entry.cachedAt).getTime();
                if (ageMs < _freshMs) {
                    return res.json({
                        orders: entry.orders, count: entry.orders.length,
                        cached: true, cachedAt: entry.cachedAt,
                        cacheAgeSeconds: Math.round(ageMs/1000)
                    });
                }
                if (!isBg) {
                    // Uporabnik: vrni stale TAKOJ, osvezitev prepusti background warmupu
                    setImmediate(() => {
                        try {
                            if (isLongWindow) warmupLongWindow(_days).catch(() => {});
                            else warmupPackingCache().catch(() => {});
                        } catch (_) {}
                    });
                    return res.json({
                        orders: entry.orders, count: entry.orders.length,
                        stale: true, refreshing: true, cachedAt: entry.cachedAt,
                        cacheAgeSeconds: Math.round(ageMs/1000),
                        circuitOpen: isMetakockaCircuitOpen()
                    });
                }
            }
            // Ni cache-a (cold start) ali background warmup -> nadaljuj na pravi fetch
        } catch (_) {}

        // IN-FLIGHT DEDUP: ce fetch za ta key ze tece (Metakocka pocasna), vrni stale cache takoj - prepreci pile-up
        // 30 min okno: background fetch z dolgimi timeouti lahko tece dlje od 10 min
        const _ifKey = `orders_${status || 'all'}_${_datePart}`;
        const _ifTs = _packingInflight.get(_ifKey);
        if (_ifTs && Date.now() - _ifTs < 30 * 60 * 1000 && !(isBg && req.query.force === '1')) {
            try {
                const _all = readPackingCache();
                const _e = _all[_ifKey];
                if (_e && _e.orders) {
                    return res.json({ orders: _e.orders, count: _e.orders.length, stale: true, refreshing: true, cachedAt: _e.cachedAt, cacheAgeSeconds: Math.round((Date.now() - new Date(_e.cachedAt).getTime()) / 1000) });
                }
            } catch (_) {}
        }
        _packingInflight.set(_ifKey, Date.now());
        { const _origJson = res.json.bind(res); res.json = (d) => { _packingInflight.delete(_ifKey); return _origJson(d); }; }

        console.log(`[Packing] Fetching orders with status: ${status}, date: ${date || 'all'}`);
        
        const queryAdvance = [];
        
        // Filter by date if provided
        if (date) {
            queryAdvance.push({ type: 'doc_date_from', value: `${date}+02:00` });
            queryAdvance.push({ type: 'doc_date_to', value: `${date}+02:00` });
        } else {
            // [2026-08-10] Privzeto 5 dni (prej 3) — najstarejsi dan je bil nepopoln.
            // Nastavljivo prek ?days=N (max 14), da se ne pretirava z Metakocko.
            // [2026-08-14] Vrednost je izracunana zgoraj (_days) — cache key jo mora upostevati.
            const PACKING_DAYS = _days;
            const fromDay = new Date(Date.now() - PACKING_DAYS * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            queryAdvance.push({ type: 'doc_date_from', value: `${fromDay}+02:00` });
        }
        
        const requestBody = {
            secret_key: METAKOCKA_SECRET,
            company_id: METAKOCKA_COMPANY_ID,
            doc_type: 'sales_order',
            result_type: 'doc',
            limit: 100, // Metakocka max is 100
            order_direction: 'desc'
        };
        
        // Filter by Noriks shops only at API level (eshop_name_list).
        // [2026-08-10] ?allshops=1 -> BREZ filtra (zajame tudi narocila izven seznama trgovin,
        // npr. klicni center z drugim virom). Dejan: stevilke se morajo ujemati z dash.
        const ALL_SHOPS = req.query.allshops === '1';
        const NORIKS_SHOPS = 'noriks.com/hr,noriks.com/hu,noriks.com/cz,noriks.com/gr,noriks.com/it,noriks.com/sk,noriks.com/pl,noriks.com/si,noriks.com/ro,noriks.com/de,noriks.com';
        if (!ALL_SHOPS) queryAdvance.push({ type: 'eshop_name_list', value: NORIKS_SHOPS });
        
        requestBody.query_advance = queryAdvance;
        
        // Paginate Metakocka API (only Noriks orders returned)
        let results = [];
        // [2026-08-14] 20 strani = 2000 najnovejsih narocil -> pri 14-dnevnem oknu je to pokrilo
        // samo ~3 dni (zato je topsellers kazal le 11.-14.). Za DOLGO okno v OZADJU dvignemo mejo.
        const MAX_PAGES = (isBg && isLongWindow) ? 200 : 20;   // [2026-08-19] 30-dnevno okno ima ~14.600 narocil; 120 strani (12.000) bi odrezalo najstarejse dneve
        let offset = 0;
        let pageNum = 0;
        // Background warmup tolerira pocasno Metakocko (nocna degradacija 02-07h: query rabi
        // tudi 2-4 min); user cold-start ostane na 90s. Skupni budget prepreci neskoncen fetch.
        const PAGE_TIMEOUT_MS = isBg ? 300000 : 90000;
        const FETCH_BUDGET_MS = 25 * 60 * 1000;
        const fetchStart = Date.now();
        while (pageNum < MAX_PAGES) {
            const pageBody = { ...requestBody, limit: 100, offset };
            let response, data, lastErr;
            if (Date.now() - fetchStart > FETCH_BUDGET_MS) {
                lastErr = new Error('Metakocka fetch budget exceeded (25 min, ' + pageNum + ' pages done)');
            } else {
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    response = await fetch('https://main.metakocka.si/rest/eshop/v1/search', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(pageBody),
                        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
                    });
                    const ct = response.headers.get('content-type') || '';
                    if (!ct.includes('json')) throw new Error('Non-JSON response (content-type: ' + ct + ')');
                    data = await response.json();
                    markMetakockaSuccess();
                    lastErr = null;
                    break;
                } catch (e) {
                    lastErr = e;
                    console.warn('[Packing] ' + new Date().toISOString() + ' Metakocka fetch attempt ' + (attempt+1) + '/2 failed (timeout=' + (PAGE_TIMEOUT_MS/1000) + 's, bg=' + isBg + '):', e.message);
                    if (attempt === 0) await new Promise(r => setTimeout(r, 500));
                }
            }
            }
            if (lastErr) {
                console.error('[Packing] Metakocka fetch failed after 2 attempts:', lastErr.message);
                markMetakockaFail();
                // Cache fallback - vrni zadnji uspesen snapshot za to (status,date) kombinacijo
                try {
                    const cacheKey = `orders_${status || 'all'}_${_datePart}`;
                    {
                        const entry = tsdb.cacheGet(cacheKey);   // [FAZA3.2] iz SQLite
                        if (entry && entry.orders) {
                            const ageMs = Date.now() - new Date(entry.cachedAt).getTime();
                            console.warn('[Packing] Returning STALE cache for ' + cacheKey + ' (cached ' + entry.cachedAt + ', age=' + Math.round(ageMs/1000) + 's, ' + entry.orders.length + ' orders)');
                            return res.json({
                                orders: entry.orders, count: entry.orders.length,
                                stale: true, cachedAt: entry.cachedAt,
                                cacheAgeSeconds: Math.round(ageMs/1000),
                                reason: 'Metakocka unreachable - prikazani podatki iz cacha'
                            });
                        }
                    }
                } catch (cacheErr) {
                    console.error('[Packing] Cache read failed:', cacheErr.message);
                }
                return res.status(503).json({ error: 'Metakocka unreachable', details: lastErr.message });
            }
            
            if (data.opr_code !== '0') {
                console.error('[Packing] Metakocka error:', data);
                return res.status(500).json({ error: 'Metakocka API error', details: data });
            }
            
            const page = data.result || [];
            results = results.concat(page);
            if (page.length < 100) break;
            offset += 100;
            pageNum++;
        }
        console.log('[Packing] Fetched ' + results.length + ' Noriks orders from Metakocka (' + (pageNum + 1) + ' pages, eshop_name_list filter)');
        
        // EN FETCH ZA VSE STATUSE: transformiramo VSA narocila, status filter se aplicira
        // sele pri pisanju cache keyev in pri odgovoru. Tako 1 Metakocka fetch napolni
        // vse 3 cache keye namesto 3 locenih fetchev (3x manj MK search-lock obremenitve).
        const allOrders = results.map(order => {
            const partner = order.partner || {};
            const receiver = order.receiver || partner;
            
            // Get customer name - prefer receiver if different
            const customerName = receiver.customer || partner.customer || 'Neznano';
            
            // Get country from partner
            let country = partner.country || '';
            // EN / global store (noriks.com without country prefix) — treat as own 'country'
            if ((order.eshop_name || '').trim() === 'noriks.com') {
                country = 'English';
            }
            
            // Parse products
            const rawProducts = order.product_list || [];
            const items = rawProducts
                .filter(p => {
                    // Filter out shipping/delivery products
                    const code = (p.code || '').toLowerCase();
                    const name = (p.name || '').toLowerCase();
                    const unit = (p.unit || '').toLowerCase();
                    
                    // Skip services (unit = 'stor')
                    if (unit === 'stor') return false;
                    
                    // Skip shipping keywords
                    const shippingKeywords = [
                        'doručenie', 'dorucenie', 'dostava', 'pošta', 'posta',
                        'gls', 'dpd', 'shipping', 'dobierka', 'dobírka', 'dobirka',
                        'poplatek', 'poplatok', 'standard', 'štandard', 'standart',
                        'express', 'paket24',
                        'kurýr', 'kuryr', 'kurier'
                    ];
                    // Additional exact-word shipping patterns (avoid substring false positives like
                    // "midnight" containing "dni" or "3-balík" / "6-balík" containing "balík").
                    // For balík/balik: require start-of-string or whitespace before (NOT preceded by
                    // digit-dash, which would match SK/CZ bundle product names like "Monochromatický 3-balík").
                    const shippingWordPatterns = [/\bdní\b/, /\bdni\b/, /\bdana\b/, /(^|\s)balík\b/, /(^|\s)balik\b/];
                    
                    for (const kw of shippingKeywords) {
                        if (code.includes(kw) || name.includes(kw)) {
                            return false;
                        }
                    }
                    for (const pattern of shippingWordPatterns) {
                        if (pattern.test(code) || pattern.test(name)) {
                            return false;
                        }
                    }
                    return true;
                })
                .map(product => {
                    const docDesc = product.doc_desc || '';
                    const code = product.code || '';
                    const nameOriginal = product.name || '';
                    const name = getSlovenianName(code, nameOriginal);
                    const amount = parseInt(product.amount) || 1;
                    
                    // Parse doc_desc to get individual items
                    const parsedItems = parseDocDesc(docDesc, code, name);
                    if (parsedItems.length === 0 || parsedItems.some(i => !i.color || !i.size)) {
                        console.log(`[Packing DEBUG] Parse issue: code="${code}" name="${name}" docDesc="${docDesc}" amount=${amount} items=${JSON.stringify(parsedItems)}`);
                    }
                    
                    // Build product label with item count
                    const totalItems = parsedItems.length * amount;
                    const productLabel = (amount > 1 ? amount + 'x ' : '') + name + 
                        (parsedItems.length > 0 ? ` (${amount > 1 ? amount + '×' + parsedItems.length + ' = ' : ''}${totalItems} kos)` : '');
                    
                    if (parsedItems.length > 0) {
                        // Multiply by amount
                        let allItems;
                        if (amount > 1) {
                            allItems = [];
                            for (let a = 0; a < amount; a++) {
                                allItems.push(...parsedItems.map(item => ({...item})));
                            }
                        } else {
                            allItems = parsedItems;
                        }
                        // Validate items — flag warnings
                        const knownSlovenianColors = ['Črna', 'Modra', 'Bela', 'Siva', 'Zelena', 'Rdeča', 'Rjava', 'Bež', 'Roza', 'Oranžna', 'Vijolična', 'Rumena', 'Turkizna', 'Temno modra', 'Temnomodra', 'Svetlo modra', 'Svetlomodra', 'Tamnoplava', 'Smeđa', 'Črna & Bela', 'Ni podatka', ''];
                        const knownTypes = ['Majica', 'Boksarice', 'Starter paket', 'Nogavice', 'Nogavica', ''];
                        // [2026-08-25 Dejan] Mystery majica je EDINI izdelek, ki sme ostati brez barve —
                        // barva je namerno presenecenje ("boja je iznenadenje"). Zato zanjo NE opozarjamo
                        // na manjkajoco/neznano barvo niti na "neprepoznan tip". Velikost pa kupec IZBERE,
                        // zato opozorilo za manjkajoco velikost ostane tudi pri Mystery.
                        const MYSTERY_RE = /presene|mystery|iznenad|iznenađ|prekvapen|meglepet|niespodziank|surpriz|έκπληξ|sorpres|überrasch/i;
                        for (const item of allItems) {
                            if (item.noWarning) { delete item.noWarning; continue; }
                            const isMystery = MYSTERY_RE.test(item.type || '') || MYSTERY_RE.test(item.color || '');
                            const warnings = [];
                            if (item.color && !knownSlovenianColors.includes(item.color) && !isMystery) {
                                warnings.push(`Neprevedena barva: "${item.color}"`);
                            }
                            if (item.type && !knownTypes.includes(item.type) && !item.type.startsWith('Nogavic') && !isMystery) {
                                warnings.push(`Neprepoznan tip: "${item.type}"`);
                            }
                            if (!item.color && !item.type.startsWith('Nogavic') && !isMystery) {
                                warnings.push('Manjka barva');
                            }
                            if (!item.size) {
                                warnings.push('Manjka velikost');
                            }
                            if (warnings.length > 0) item.warnings = warnings;
                        }
                        return { label: productLabel, items: allItems, code };
                    }
                    
                    // [2026-08-12] Izdelki BREZ variacij (BUNION, ORTOPAS, FISIOREST, KIDSNEST, KNEEFIX,
                    // NORIKSHERS-*): nimajo barve/velikosti, zato "Ni bilo mogoce parsati" ni napaka.
                    // Kolicina = amount x _bundle_pairs (ce je v doc_desc), sicer amount.
                    const NOVAR_CODES = /BUNION|ORTOPAS|FISIOREST|KIDSNEST|KIDNEST|KNEEFIX|KNEEHEAT|SNORE|CONTROLPRO|NORIKSHERS/;
                    if (NOVAR_CODES.test(code)) {
                        const bp = (docDesc || '').match(/_bundle_pairs\s*:\s*(\d+)/i);
                        const per = bp ? (parseInt(bp[1], 10) || 1) : 1;
                        const cleanName = getSlovenianName(code, nameOriginal) || productType || nameOriginal;
                        const novarItems = [];
                        for (let a = 0; a < amount * per; a++) {
                            novarItems.push({ type: cleanName, color: '', size: '', noWarning: true });
                        }
                        return { label: productLabel, items: novarItems, code };
                    }

                    // Fallback — flag as warning (no parsed data!)
                    const fallbackItems = [];
                    for (let a = 0; a < amount; a++) {
                        // [2026-08-26 Dejan] Menjava ("Naročilo kupca: menjava …") po naravi nima
                        // variant — ni je treba oznacevati kot tezavo, ker podatka NIKJER ni.
                        const jeMenjava = /menjav|zamjen|zamen|csere|wymian|schimb|ανταλλαγ|cambio|umtausch|exchange/i
                            .test(String(order.buyer_order || ''));
                        fallbackItems.push(jeMenjava
                            ? { type: name, color: '', size: '', colorHex: '#ccc', noWarning: true }
                            : { type: name, color: '', size: '', colorHex: '#ccc', warnings: ['Ni bilo mogoče parsati izdelkov — preverite ročno!'] });
                    }
                    return { label: productLabel, items: fallbackItems, code };
                });
            
            // Parse date and time
            let dateStr = '';
            let timeStr = '';
            // Prefer shipped_date for "Odpremljen" orders, fallback to doc_date
            const dateSource = order.shipped_date || order.doc_date;
            if (dateSource) {
                dateStr = dateSource.split('+')[0].split('T')[0];
            }
            // Get time from order_create_ts (e.g., "2026-02-26T13:04:57+02:00")
            if (order.order_create_ts) {
                const match = order.order_create_ts.match(/T(\d{2}:\d{2})/);
                if (match) timeStr = match[1];
            }
            
            // Order created date/time
            let orderDate = '', orderTime = '';
            if (order.order_create_ts) {
                const parts = order.order_create_ts.split('+')[0].split('T');
                orderDate = parts[0] || '';
                orderTime = parts[1] ? parts[1].substring(0, 5) : '';
            }
            // Shipped date
            let shippedDate = '';
            if (order.shipped_date) {
                shippedDate = order.shipped_date.split('+')[0].split('T')[0];
            }
            
            return {
                id: order.count_code,
                customer: customerName,
                date: dateStr,
                time: timeStr,
                orderDate: orderDate,
                orderTime: orderTime,
                shippedDate: shippedDate,
                country: country,
                status: order.status_code,
                currency: order.currency_code || 'EUR',
                total: order.sum_all || '0',
                products: items, // [{label, items: [...]}]
                items: items.map(p => p.items || p), // flat for backward compat
                _wcRef: order.title || '', // e.g. "NORIKS-HR-5779" for WC lookup
                // [2026-08-25 Dejan] Gumba na kartici: odpri narocilo v WooCommerce / Metakocki.
                // buyer_order je stevilka WC narocila; ce je v obliki "NORIKS-HR-5779", vzamemo stevilke.
                // [2026-08-26 Dejan] Stevilka WC narocila ni vedno v istem polju: nekje je v
                // buyer_order ("NORIKS-HR-13006" ali "9075"), drugje je tam IME kupca
                // ("nViera Andrejkova") in stevilka je v title. Vzamemo prvega, ki ima stevilko.
                wcId: (() => {
                    // [2026-08-26 Dejan] bank_ref_number NI stevilka WC narocila — je samo
                    // metakockina stevilka brez posevnice ("49619/2026" -> "496192026").
                    // Povezava iz nje vrne 404, kar je slabse kot da povezave ni.
                    // Zato: samo buyer_order in title, in nikoli vrednost, ki je enaka
                    // metakockini stevilki.
                    const mkStevilke = String(order.count_code || '').replace(/\D/g, '');
                    for (const kandidat of [order.buyer_order, order.title]) {
                        const m = String(kandidat || '').match(/(\d+)\s*$/);
                        if (!m || m[1].length < 3) continue;
                        if (m[1] === mkStevilke) continue;
                        return m[1];
                    }
                    return '';
                })(),
                mkId: String(order.mk_id || ''),
                // [2026-08-25 Dejan] Menjave nimajo variant (0,00 EUR, brez velikosti/barve) —
                // na kartici to izpisemo, da skladisce ve, zakaj podatkov ni.
                // POZOR: polja s podcrtajem (_eshop) se pred odgovorom pobrisejo (glej 'delete o._eshop'),
                // zato trg za povezavo do WooCommerce shranimo v CISTO polje.
                eshopUrl: order.eshop_name || '',
                buyerOrder: String(order.buyer_order || ''),
                isExchange: /menjav|zamjen|zamen|csere|wymian|schimb|ανταλλαγ|cambio|umtausch|exchange/i.test(String(order.buyer_order || '')),
                _eshop: order.eshop_name || '', // e.g. "noriks.com/hr"
                _rawProducts: rawProducts // keep raw for enrichment check
            };
        });
        
        // === WooCommerce enrichment for ORTO orders missing doc_desc ===
        await enrichOrtoOrdersFromWC(allOrders);

        // Clean up internal fields before sending
        for (const o of allOrders) { delete o._wcRef; delete o._eshop; delete o._rawProducts; }

        // Write cache za VSE 3 statuse iz ENEGA fetcha (+ zahtevani status, ce je drugacen).
        // En MK fetch -> warmup rabi samo 1 klic namesto 3.
        try {
            // [2026-08-14] Vsak uspesen fetch (5- ali 14-dnevni) dopolni kotalece se skladisce.
            mergeIntoRolling(allOrders);
            const datePart = _datePart;
            const cacheStatuses = [...new Set(['Odpremljen', 'Novo', 'Pripravljen za odpremo', status].filter(Boolean))];
            for (const s of cacheStatuses) {
                writePackingCacheEntry(`orders_${s}_${datePart}`, allOrders.filter(o => (o.status || '').startsWith(s)));
            }
            if (!status) writePackingCacheEntry(`orders_all_${datePart}`, allOrders);
        } catch (cacheErr) {
            console.error('[Packing] Cache write failed:', cacheErr.message);
        }

        // Odgovor: filtriraj po zahtevanem statusu + limit
        let orders = allOrders;
        if (status) {
            orders = orders.filter(o => (o.status || '').startsWith(status));
            console.log('[Packing] After status filter (' + status + '): ' + orders.length + ' orders');
        }
        orders = orders.slice(0, parseInt(limit));

        res.json({ orders, count: orders.length });
        
    } catch (e) {
        console.error('[Packing] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Bundle definitions - what's inside each known bundle type
// SKU to Slovenian product name mapping - for packing display
function getSlovenianName(code, originalName) {
    const baseCode = (code || '').replace(/-((?:\d*X*)?[SMLX]{1,3}L?)$/, '');
    const nameMap = {
        'NORIKS-MIDNIGHT-3-PACK': 'Ponoćni mix – 3-paket',
        'NORIKS-URBAN-3-PACK': 'Urbano-zemljani – 3-paket',
        'NORIKS-MONOCHROME-3-PACK': 'Monokromni – 3-paket',
        'NORIKS-COASTAL-3-PACK': 'Obalni – 3-paket',
        'NORIKS-ALL-BLACK-3-PACK': 'Črne majice – 3-paket',
        'NORIKS-ALL-BLACK-6-PACK': 'Črne majice – 6-paket',
        'NORIKS-ALL-BLACK-9-PACK': 'Črne majice – 9-paket',
        'NORIKS-ALL-BLACK-9-PACK-2': 'Monokromni mix – 9-paket',
        'NORIKS-ALL-BLACK-12-PACK': 'Črne majice – 12-paket',
        'NORIKS-ALL-BLACK-15-PACK': 'Črne majice – 15-paket',
        'NORIKS-ALL-WHITE-3-PACK': 'Bele majice – 3-paket',
        'NORIKS-ALL-WHITE-6-PACK': 'Bele majice – 6-paket',
        'NORIKS-ALL-WHITE-9-PACK': 'Bele majice – 9-paket',
        'NORIKS-ALL-WHITE-12-PACK': 'Bele majice – 12-paket',
        'NORIKS-ALL-WHITE-15-PACK': 'Bele majice – 15-paket',
        'NORIKS-CITY-COMBO-6-PACK': 'Mestni combo – 6-paket',
        'NORIKS-EARTH-TONES-6-PACK': 'Zemljani toni – 6-paket',
        'NORIKS-EVERYDAY-6-PACK': 'Vsakdanji mix – 6-paket',
        'NORIKS-MONOCHROME-6-PACK': 'Monokromni mix – 6-paket',
        'NORIKS-MONOCHROME-9-PACK': 'Monokromni majice – 9-paket',
        'NORIKS-FULL-SPECTRUM-9-PACK': 'Poln spekter – 9-paket',
        'NORIKS-NEUTRAL-MIX-9-PACK': 'Nevtralni mix – 9-paket',
        'NORIKS-STREET-PACK-9-PACK': 'Ulični paket – 9-paket',
        'NORIKS-FULL-BASICS-12-PACK': 'Osnovni – 12-paket',
        'NORIKS-MONOCHROME-DOZEN': 'Monokromni mix – 12-paket',
        'NORIKS-EARTH-DOZEN': 'Zemljani toni – 12-paket',
        'NORIKS-EVERYDAY-MIX-12-PACK': 'Vsakdanji mix – 12-paket',
        'NORIKS-FULL-BASICS-15-PACK': 'Osnovni – 15-paket',
        'NORIKS-BOX-BLACK-3-PACK': 'Črne boksarice – 3-paket',
        'NORIKS-BOX-BLACK-5-PACK': 'Črne boksarice – 5-paket',
        'NORIKS-BOX-BLACK-7-PACK': 'Črne boksarice – 7-paket',
        'NORIKS-BOX-BLACK-10-PACK': 'Črne boksarice – 10-paket',
        'NORIKS-BOX-BLACK-15-PACK': 'Črne boksarice – 15-paket',
        'NORIKS-BOX-BUNDLE-3-FIRST': 'Monokromni boksarice – 3-paket',
        'NORIKS-BOX-BUNDLE-3-SECOND': 'Urbano-zemljani boksarice – 3-paket',
        'NORIKS-BOX-BUNDLE-3-THIRD': 'Ponoćni mix boksarice – 3-paket',
        'NORIKS-BOX-BUNDLE-7-FIRST': 'Urbano-zemljani boksarice – 7-paket',
        'NORIKS-BOX-BUNDLE-7-SECOND': 'Ponoćni mix boksarice – 7-paket',
        'NORIKS-BOX-BUNDLE-10-FIRST': 'Mix barv boksarice – 10-paket',
        'NORIKS-BOX-BUNDLE-10-SECOND': 'Temni mix boksarice – 10-paket',
        'NORIKS-BOX-BUNDLE-15-FIRST': 'Mix barv boksarice – 15-paket',
        'NORIKS-BOX-BUNDLE-15-SECOND': 'Temni mix boksarice – 15-paket',
        'NORIKS-BOXERS-BLACK': 'Črne boksarice',
        'NORIKS-BOXERS-GRAY': 'Sive boksarice',
        'NORIKS-BOXERS-RED': 'Rdeče boksarice',
        'NORIKS-BOXERS-BLUE': 'Modre boksarice',
        'NORIKS-BOXERS-GREEN': 'Zelene boksarice',
        'NORIKS-ONE-BLACK': 'Črna majica',
        'NORIKS-ONE-WHITE': 'Bela majica',
        'NORIKS-ONE-GRAY': 'Siva majica',
        'NORIKS-ONE-DARKBLUE': 'Temno modra majica',
        'NORIKS-ONE-GREEN': 'Zelena majica',
        'NORIKS-ONE-BEIGE': 'Bež majica',
        'NORIKS-ONE-BROWN': 'Rjava majica',
        'NORIKS-BOXERS-ORTO': 'AirFlow Modal boksarice',
        'NORIKS-SHIRTS-ORTO': 'Majica',
        'NORIKS-STARTER-ORTO': 'Starter set',
        'NORIKS-SOCKS-BLACK-5PC': 'Črne nogavice (5 parov)',
        'NORIKS-SOCKS-BLACK-10PC': 'Črne nogavice (10 parov)',
        'NORIKS-SOCKS-BLACK-15PC': 'Črne nogavice (15 parov)',
        'NORIKS-SOCKS-WHITE-5PC': 'Bele nogavice (5 parov)',
        'NORIKS-SOCKS-WHITE-10PC': 'Bele nogavice (10 parov)',
        'NORIKS-SOCKS-WHITE-15PC': 'Bele nogavice (15 parov)',
        'NORIKS-SOCKS-BW-10PC': 'Nogavice črno-bele (10 parov)',
    };
    // Try exact code, then base code (without size suffix), then bundle patterns
    if (nameMap[code]) return nameMap[code];
    if (nameMap[baseCode]) return nameMap[baseCode];
    // Try matching bundle codes with variant suffix (e.g. NORIKS-BUNDLE-SHIRTS-BOX-P-1)
    if (code.includes('BUNDLE-SHIRTS-BOX') || code.includes('BUNDLE-SH-BOX')) {
        const is4_10 = code.includes('4-10');
        const is5_5 = code.includes('5-5');
        if (is4_10) return 'Starter paket – 4 majice + 10 boksaric';
        if (is5_5) return 'Starter paket – 5 majic + 5 boksaric';
        return 'Starter paket – 2 majici + 5 boksaric';
    }
    return originalName;
}

const bundleContents = {
    // Black boxer packs
    'NORIKS-BOX-BLACK-3-PACK': (size) => [
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Črna', size },
    ],
    'NORIKS-BOX-BLACK-5-PACK': (size) => [
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Črna', size },
    ],
    // Mystery 2-pack majici — barva presenečenje (skrivnost), izbereš samo velikost.
    // Variabilen WC produkt (parent NORIKS-MYSTERY-SHIRT-2X, variacije po velikosti),
    // 2 majici v paketu. Brez tega vnosa bi parseDocDesc vrnil samo 1 kos + prazno barvo.
    'NORIKS-MYSTERY-SHIRT-2X': (size) => [
        { type: 'Majica', color: 'Presenečenje', size },
        { type: 'Majica', color: 'Presenečenje', size },
    ],
    // All black shirts
    'NORIKS-ALL-BLACK-3-PACK': (size) => [
        { type: 'Majica', color: 'Črna', size },
        { type: 'Majica', color: 'Črna', size },
        { type: 'Majica', color: 'Črna', size },
    ],
    // All white shirts
    'NORIKS-ALL-WHITE-3-PACK': (size) => [
        { type: 'Majica', color: 'Bela', size },
        { type: 'Majica', color: 'Bela', size },
        { type: 'Majica', color: 'Bela', size },
    ],
    // Midnight/Ponoćni Mix 3-pack SHIRTS (črna, siva, temno modra — verified from WC image)
    'NORIKS-MIDNIGHT-3-PACK': (size) => [
        { type: 'Majica', color: 'Črna', size },
        { type: 'Majica', color: 'Siva', size },
        { type: 'Majica', color: 'Temno modra', size },
    ],
    // Urban-Earth/Urbano-Zemljani 3-pack SHIRTS (zelena, siva, temno modra — verified from WC image)
    'NORIKS-URBAN-3-PACK': (size) => [
        { type: 'Majica', color: 'Zelena', size },
        { type: 'Majica', color: 'Siva', size },
        { type: 'Majica', color: 'Temno modra', size },
    ],
    // Coastal 3-pack (blue, green, white SHIRTS — verified from WC categories)
    'NORIKS-COASTAL-3-PACK': (size) => [
        { type: 'Majica', color: 'Modra', size },
        { type: 'Majica', color: 'Zelena', size },
        { type: 'Majica', color: 'Bela', size },
    ],
    // Monochrome 3-pack (black, white, grey SHIRTS - not boxers!)
    'NORIKS-MONOCHROME-3-PACK': (size) => [
        { type: 'Majica', color: 'Črna', size },
        { type: 'Majica', color: 'Bela', size },
        { type: 'Majica', color: 'Siva', size },
    ],
    // City combo 6-pack (6 SHIRTS — verified from WC: category "6-paket majice")
    'NORIKS-CITY-COMBO-6-PACK': (size) => [
        { type: 'Majica', color: 'Črna', size },
        { type: 'Majica', color: 'Bela', size },
        { type: 'Majica', color: 'Modra', size },
        { type: 'Majica', color: 'Siva', size },
        { type: 'Majica', color: 'Zelena', size },
        { type: 'Majica', color: 'Temno modra', size },
    ],
    // Ponoćni mix 7-pack (2x crna, 2x siva, 3x modra boksarice)
    'NORIKS-BOX-BUNDLE-7-SECOND': (size) => [
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Siva', size },
        { type: 'Boksarice', color: 'Siva', size },
        { type: 'Boksarice', color: 'Modra', size },
        { type: 'Boksarice', color: 'Modra', size },
        { type: 'Boksarice', color: 'Modra', size },
    ],
    // ========== SHIRT PACKS (verified from WC product images) ==========
    // Neutral mix 9-pack: image shows 6 unique colors, 9 total = 3 extra of core colors
    // Colors from image: črna, siva, tamnoplava, zelena, smeđa, bela + 3 extra (črna, bela, siva)
    'NORIKS-NEUTRAL-MIX-9-PACK': (size) => [
        { type: 'Majica', color: 'Črna', size },
        { type: 'Majica', color: 'Črna', size },
        { type: 'Majica', color: 'Bela', size },
        { type: 'Majica', color: 'Bela', size },
        { type: 'Majica', color: 'Siva', size },
        { type: 'Majica', color: 'Siva', size },
        { type: 'Majica', color: 'Temno modra', size },
        { type: 'Majica', color: 'Rjava', size },
        { type: 'Majica', color: 'Zelena', size },
    ],
    // Full spectrum 9-pack: image = 2x črna, 1x siva, 1x tamnoplava, 1x zelena, 1x smeđa, 1x bež, 1x bela + 1 extra
    'NORIKS-FULL-SPECTRUM-9-PACK': (size) => [
        { type: 'Majica', color: 'Črna', size },
        { type: 'Majica', color: 'Črna', size },
        { type: 'Majica', color: 'Siva', size },
        { type: 'Majica', color: 'Temno modra', size },
        { type: 'Majica', color: 'Zelena', size },
        { type: 'Majica', color: 'Rjava', size },
        { type: 'Majica', color: 'Bež', size },
        { type: 'Majica', color: 'Bela', size },
        { type: 'Majica', color: 'Bela', size },
    ],
    // Street pack 9-pack: image = 2x črna, 1x siva, 1x tamnoplava, 1x zelena, 1x smeđa, 1x bež, 1x bela + 1 extra
    'NORIKS-STREET-PACK-9-PACK': (size) => [
        { type: 'Majica', color: 'Črna', size },
        { type: 'Majica', color: 'Črna', size },
        { type: 'Majica', color: 'Siva', size },
        { type: 'Majica', color: 'Temno modra', size },
        { type: 'Majica', color: 'Zelena', size },
        { type: 'Majica', color: 'Rjava', size },
        { type: 'Majica', color: 'Bež', size },
        { type: 'Majica', color: 'Bela', size },
        { type: 'Majica', color: 'Bela', size },
    ],
    // Monochrome 9-pack: image = 3x črna, 3x siva, 3x bela
    'NORIKS-MONOCHROME-9-PACK': (size) => [
        { type: 'Majica', color: 'Črna', size },
        { type: 'Majica', color: 'Črna', size },
        { type: 'Majica', color: 'Črna', size },
        { type: 'Majica', color: 'Siva', size },
        { type: 'Majica', color: 'Siva', size },
        { type: 'Majica', color: 'Siva', size },
        { type: 'Majica', color: 'Bela', size },
        { type: 'Majica', color: 'Bela', size },
        { type: 'Majica', color: 'Bela', size },
    ],
    // All black shirts 3/6/9/12/15
    'NORIKS-ALL-BLACK-3-PACK': (size) => Array(3).fill(null).map(() => ({ type: 'Majica', color: 'Črna', size })),
    'NORIKS-ALL-BLACK-6-PACK': (size) => Array(6).fill(null).map(() => ({ type: 'Majica', color: 'Črna', size })),
    'NORIKS-ALL-BLACK-9-PACK': (size) => Array(9).fill(null).map(() => ({ type: 'Majica', color: 'Črna', size })),
    'NORIKS-ALL-BLACK-12-PACK': (size) => Array(12).fill(null).map(() => ({ type: 'Majica', color: 'Črna', size })),
    'NORIKS-ALL-BLACK-15-PACK': (size) => Array(15).fill(null).map(() => ({ type: 'Majica', color: 'Črna', size })),
    // All white shirts 3/6/9/12/15
    'NORIKS-ALL-WHITE-3-PACK': (size) => Array(3).fill(null).map(() => ({ type: 'Majica', color: 'Bela', size })),
    'NORIKS-ALL-WHITE-6-PACK': (size) => Array(6).fill(null).map(() => ({ type: 'Majica', color: 'Bela', size })),
    'NORIKS-ALL-WHITE-9-PACK': (size) => Array(9).fill(null).map(() => ({ type: 'Majica', color: 'Bela', size })),
    'NORIKS-ALL-WHITE-12-PACK': (size) => Array(12).fill(null).map(() => ({ type: 'Majica', color: 'Bela', size })),
    'NORIKS-ALL-WHITE-15-PACK': (size) => Array(15).fill(null).map(() => ({ type: 'Majica', color: 'Bela', size })),
    // Monochrome 6-pack: 3x črna, 3x bela
    'NORIKS-MONOCHROME-6-PACK': (size) => [
        ...Array(3).fill(null).map(() => ({ type: 'Majica', color: 'Črna', size })),
        ...Array(3).fill(null).map(() => ({ type: 'Majica', color: 'Bela', size })),
    ],
    // Monochrome dozen 12-pack: 6x črna, 6x bela
    'NORIKS-MONOCHROME-DOZEN': (size) => [
        ...Array(6).fill(null).map(() => ({ type: 'Majica', color: 'Črna', size })),
        ...Array(6).fill(null).map(() => ({ type: 'Majica', color: 'Bela', size })),
    ],
    // [2026-08-26 Dejan] Zemljani toni 6-paket — sestava s slike izdelka
    // (urban-earth-6x.jpg): 3x črna, 1x temno modra, 1x zelena, 1x bež.
    'NORIKS-EARTH-TONES-6-PACK': (size) => [
        ...Array(3).fill(null).map(() => ({ type: 'Majica', color: 'Črna', size })),
        { type: 'Majica', color: 'Temno modra', size },
        { type: 'Majica', color: 'Zelena', size },
        { type: 'Majica', color: 'Bež', size },
    ],
    // [2026-08-26 Dejan] Vsakdanji mix 6-paket — slika everyday-6X.jpg:
    // po ena črna, siva, temno modra, zelena, bež, bela.
    'NORIKS-EVERYDAY-6-PACK': (size) => [
        { type: 'Majica', color: 'Črna', size },
        { type: 'Majica', color: 'Siva', size },
        { type: 'Majica', color: 'Temno modra', size },
        { type: 'Majica', color: 'Zelena', size },
        { type: 'Majica', color: 'Bež', size },
        { type: 'Majica', color: 'Bela', size },
    ],
    // [2026-08-26 Dejan] Mešane boksarice 10-paket — slika boksarice_10x-mesane.webp:
    // 2x črna, 2x siva, 3x modra, 2x zelena, 1x rdeča.  — POTRDIL Dejan, 26.8.2026.
    'NORIKS-BOX-BUNDLE-10-FIRST': (size) => [
        ...Array(2).fill(null).map(() => ({ type: 'Boksarice', color: 'Črna', size })),
        ...Array(2).fill(null).map(() => ({ type: 'Boksarice', color: 'Siva', size })),
        ...Array(3).fill(null).map(() => ({ type: 'Boksarice', color: 'Modra', size })),
        ...Array(2).fill(null).map(() => ({ type: 'Boksarice', color: 'Zelena', size })),
        { type: 'Boksarice', color: 'Rdeča', size },
    ],
    // Earth dozen 12-pack: image = 6x črna, 1x tamnoplava, 2x bež, 3x zelena
    'NORIKS-EARTH-DOZEN': (size) => [
        ...Array(6).fill(null).map(() => ({ type: 'Majica', color: 'Črna', size })),
        { type: 'Majica', color: 'Temno modra', size },
        ...Array(2).fill(null).map(() => ({ type: 'Majica', color: 'Bež', size })),
        ...Array(3).fill(null).map(() => ({ type: 'Majica', color: 'Zelena', size })),
    ],
    // Everyday mix 12-pack: image = 2x each of črna, zelena, tamnoplava, siva, bež, bela
    'NORIKS-EVERYDAY-MIX-12-PACK': (size) => [
        ...Array(2).fill(null).map(() => ({ type: 'Majica', color: 'Črna', size })),
        ...Array(2).fill(null).map(() => ({ type: 'Majica', color: 'Zelena', size })),
        ...Array(2).fill(null).map(() => ({ type: 'Majica', color: 'Temno modra', size })),
        ...Array(2).fill(null).map(() => ({ type: 'Majica', color: 'Siva', size })),
        ...Array(2).fill(null).map(() => ({ type: 'Majica', color: 'Bež', size })),
        ...Array(2).fill(null).map(() => ({ type: 'Majica', color: 'Bela', size })),
    ],
    // Full basics 12-pack: image = 3x črna, 2x siva, 2x tamnoplava, 1x smeđa, 1x bež, 1x zelena, 2x bela
    'NORIKS-FULL-BASICS-12-PACK': (size) => [
        ...Array(3).fill(null).map(() => ({ type: 'Majica', color: 'Črna', size })),
        ...Array(2).fill(null).map(() => ({ type: 'Majica', color: 'Siva', size })),
        ...Array(2).fill(null).map(() => ({ type: 'Majica', color: 'Temno modra', size })),
        { type: 'Majica', color: 'Rjava', size },
        { type: 'Majica', color: 'Bež', size },
        { type: 'Majica', color: 'Zelena', size },
        ...Array(2).fill(null).map(() => ({ type: 'Majica', color: 'Bela', size })),
    ],
    // Full basics 15-pack: image = 3x črna, 2x tamnoplava, 1x zelena, 2x siva, 2x smeđa, 2x bež, 3x bela
    'NORIKS-FULL-BASICS-15-PACK': (size) => [
        ...Array(3).fill(null).map(() => ({ type: 'Majica', color: 'Črna', size })),
        ...Array(2).fill(null).map(() => ({ type: 'Majica', color: 'Temno modra', size })),
        { type: 'Majica', color: 'Zelena', size },
        ...Array(2).fill(null).map(() => ({ type: 'Majica', color: 'Siva', size })),
        ...Array(2).fill(null).map(() => ({ type: 'Majica', color: 'Rjava', size })),
        ...Array(2).fill(null).map(() => ({ type: 'Majica', color: 'Bež', size })),
        ...Array(3).fill(null).map(() => ({ type: 'Majica', color: 'Bela', size })),
    ],
    // ========== BOXER PACKS (3-packs) ==========
    // Ponoćni mix 3-pack (1x crna, 2x modra)
    'NORIKS-BOX-BUNDLE-3-THIRD': (size) => [
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Modra', size },
        { type: 'Boksarice', color: 'Modra', size },
    ],
    // Urbano-zemljani 3-pack (1x crna, 1x zelena, 1x siva)
    'NORIKS-BOX-BUNDLE-3-SECOND': (size) => [
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Zelena', size },
        { type: 'Boksarice', color: 'Siva', size },
    ],
    // Monokromni 3-pack boxers (1x siva, 1x modra, 1x crna — verified from WC)
    'NORIKS-BOX-BUNDLE-3-FIRST': (size) => [
        { type: 'Boksarice', color: 'Siva', size },
        { type: 'Boksarice', color: 'Modra', size },
        { type: 'Boksarice', color: 'Črna', size },
    ],
    // ========== BOXER PACKS (larger) ==========
    // Urbano-zemljani 7-pack (2x crne, 2x plave, 2x zelene, 1x siva)
    'NORIKS-BOX-BUNDLE-7-FIRST': (size) => [
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Modra', size },
        { type: 'Boksarice', color: 'Modra', size },
        { type: 'Boksarice', color: 'Zelena', size },
        { type: 'Boksarice', color: 'Zelena', size },
        { type: 'Boksarice', color: 'Siva', size },
    ],
    // Ponoćni mix 5-pack (2x crne, 3x modre)
    'NORIKS-BOX-BUNDLE-5-FIRST': (size) => [
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Modra', size },
        { type: 'Boksarice', color: 'Modra', size },
        { type: 'Boksarice', color: 'Modra', size },
    ],
    // Urbano-zemljani 5-pack (2x sive, 2x crne, 1x zelena)
    'NORIKS-BOX-BUNDLE-5-SECOND': (size) => [
        { type: 'Boksarice', color: 'Siva', size },
        { type: 'Boksarice', color: 'Siva', size },
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Zelena', size },
    ],
    // Black 7/10/15 packs
    'NORIKS-BOX-BLACK-7-PACK': (size) => Array(7).fill(null).map(() => ({ type: 'Boksarice', color: 'Črna', size })),
    'NORIKS-BOX-BLACK-10-PACK': (size) => Array(10).fill(null).map(() => ({ type: 'Boksarice', color: 'Črna', size })),
    'NORIKS-BOX-BLACK-15-PACK': (size) => Array(15).fill(null).map(() => ({ type: 'Boksarice', color: 'Črna', size })),
    // Miješani 10-pack (2x crne, 2x sive, 2x modre, 2x zelene, 2x bele)
    'NORIKS-BOX-BLACK-7-PACK-2': (size) => [
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Črna', size },
        { type: 'Boksarice', color: 'Siva', size },
        { type: 'Boksarice', color: 'Siva', size },
        { type: 'Boksarice', color: 'Modra', size },
        { type: 'Boksarice', color: 'Modra', size },
        { type: 'Boksarice', color: 'Zelena', size },
        { type: 'Boksarice', color: 'Zelena', size },
        { type: 'Boksarice', color: 'Bela', size },
        { type: 'Boksarice', color: 'Bela', size },
    ],
    // Tamni 10-pack (5x crne, 5x plave)
    'NORIKS-BOX-BLACK-7-PACK-3': (size) => [
        ...Array(5).fill(null).map(() => ({ type: 'Boksarice', color: 'Črna', size })),
        ...Array(5).fill(null).map(() => ({ type: 'Boksarice', color: 'Modra', size })),
    ],
    // Miješani 15-pack (5x crne, 3x plave, 3x sive, 2x zelene, 2x bele)
    'NORIKS-BOX-BUNDLE-15-FIRST': (size) => [
        ...Array(5).fill(null).map(() => ({ type: 'Boksarice', color: 'Črna', size })),
        ...Array(3).fill(null).map(() => ({ type: 'Boksarice', color: 'Modra', size })),
        ...Array(3).fill(null).map(() => ({ type: 'Boksarice', color: 'Siva', size })),
        ...Array(2).fill(null).map(() => ({ type: 'Boksarice', color: 'Zelena', size })),
        ...Array(2).fill(null).map(() => ({ type: 'Boksarice', color: 'Bela', size })),
    ],
    // Tamni 15-pack (10x crne, 5x plave)
    'NORIKS-BOX-BUNDLE-15-SECOND': (size) => [
        ...Array(10).fill(null).map(() => ({ type: 'Boksarice', color: 'Črna', size })),
        ...Array(5).fill(null).map(() => ({ type: 'Boksarice', color: 'Modra', size })),
    ],
};

// Type translations for doc_desc parsing (multi-language)
const typeTranslations = {
    'Tricka': 'Majica', 'Boxerky': 'Boksarice', 'Tričko': 'Majica',
    'Boxerky 1': 'Boksarice', 'Boxerky 2': 'Boksarice', 'Boxerky 3': 'Boksarice',
    'Tricka 1': 'Majica', 'Tricka 2': 'Majica', 'Tricka 3': 'Majica',
    'Koszulka': 'Majica', 'Koszulka 1': 'Majica', 'Koszulka 2': 'Majica',
    'Bokserki 1': 'Boksarice', 'Bokserki 2': 'Boksarice',
    'Póló': 'Majica', 'Póló 1': 'Majica', 'Póló 2': 'Majica',
    'Maglietta': 'Majica', 'Boxer': 'Boksarice',
    'Majica': 'Majica', 'Majica 1': 'Majica', 'Majica 2': 'Majica',
    'Bokserica': 'Boksarice', 'Bokserica 1': 'Boksarice', 'Bokserica 2': 'Boksarice',
    'Boksarice': 'Boksarice',
    'Μπλούζα': 'Majica', 'Μπλούζα 1': 'Majica', 'Μπλούζα 2': 'Majica',
    'Μπόξερ': 'Boksarice', 'Μπόξερ 1': 'Boksarice', 'Μπόξερ 2': 'Boksarice',
    'Tshirt': 'Majica', 'Shirt': 'Majica', 'T-shirt': 'Majica',
    'majica': 'Majica', 'bokserica': 'Boksarice',
    'Koszulki': 'Majica', 'Bokserki': 'Boksarice',
    // Czech with háčky
    'Trička': 'Majica', 'Trička 1': 'Majica', 'Trička 2': 'Majica', 'Trička 3': 'Majica',
    'Tričko': 'Majica', 'Tričko 1': 'Majica', 'Tričko 2': 'Majica',
    // Hungarian
    'Póló': 'Majica', 'Póló 1': 'Majica', 'Póló 2': 'Majica', 'Póló 3': 'Majica',
    'Alsónadrág': 'Boksarice', 'Alsónadrág 1': 'Boksarice', 'Alsónadrág 2': 'Boksarice',
    'Boxer': 'Boksarice', 'Boxer 1': 'Boksarice', 'Boxer 2': 'Boksarice',
    // Italian
    'Maglietta': 'Majica', 'Maglietta 1': 'Majica', 'Maglietta 2': 'Majica',
    'Boxer': 'Boksarice',
    // Greek extended
    'Μπλούζα': 'Majica', 'Μπλούζα 1': 'Majica', 'Μπλούζα 2': 'Majica', 'Μπλούζα 3': 'Majica',
    'Μπόξερ': 'Boksarice', 'Μπόξερ 1': 'Boksarice', 'Μπόξερ 2': 'Boksarice', 'Μπόξερ 3': 'Boksarice',
    'Μπόξερ 2 2': 'Boksarice',
    // German
    'Unterhemd': 'Majica', 'Unterhemd 1': 'Majica', 'Unterhemd 2': 'Majica', 'Unterhemd 3': 'Majica',
    'Unterhose': 'Boksarice', 'Unterhose 1': 'Boksarice', 'Unterhose 2': 'Boksarice', 'Unterhose 3': 'Boksarice',
    'Socken': 'Nogavice', 'Socken 1': 'Nogavice', 'Socken 2': 'Nogavice', 'Socken 3': 'Nogavice',
    // Manjkajoci lokalizirani tipi za SHGIFTS bundle (T-Shirt/Boxershorts + nogavice po jezikih)
    'T-Shirt': 'Majica', 'T-Shirt 1': 'Majica', 'T-Shirt 2': 'Majica',
    // RO majica variante (SHGIFTS)
    'Tricou': 'Majica', 'Tricou 1': 'Majica', 'Tricou 2': 'Majica', 'Tricouri': 'Majica',
    'Boxershorts': 'Boksarice', 'Boxershorts 1': 'Boksarice', 'Boxershorts 2': 'Boksarice',
    // Nogavice po jezikih
    'Skarpety': 'Nogavice', 'Ponozky': 'Nogavice', 'Ponožky': 'Nogavice',
    'Sosete': 'Nogavice', 'Șosete': 'Nogavice', 'Sosete 1': 'Nogavice',
    'Zokni': 'Nogavice', 'Calze': 'Nogavice', 'Zoknik': 'Nogavice', 'Nogavice': 'Nogavice',
    'Καλτσες': 'Nogavice', 'Κάλτσες': 'Nogavice', 'κάλτσες': 'Nogavice',
    // Grski deminutivi (SHGIFTS): Μπλουζάκι=majica, Μποξεράκι=boksarice
    'Μπλουζάκι': 'Majica', 'μπλουζάκι': 'Majica', 'Μπλουζάκι 1': 'Majica', 'Μπλουζάκι 2': 'Majica',
    'Μποξεράκι': 'Boksarice', 'μποξεράκι': 'Boksarice', 'Μποξεράκι 1': 'Boksarice',
    // PL/RO boksarice varijante
    'Bokserki 3': 'Boksarice', 'Boxeri': 'Boksarice', 'Boxeri 1': 'Boksarice',
};

// Color translations for doc_desc (multi-language → Slovenian)
const colorTranslationsServer = {
    // Czech/Slovak
    'modrá': 'Modra', 'modra': 'Modra', 'zelená': 'Zelena', 'zelena': 'Zelena',
    'červená': 'Rdeča', 'cervena': 'Rdeča', 'čierna': 'Črna', 'cierna': 'Črna',
    'černá': 'Črna', 'cerna': 'Črna', 'biela': 'Bela', 'bílá': 'Bela', 'bila': 'Bela',
    'šedá': 'Siva', 'seda': 'Siva',
    // Polish
    'czarny': 'Črna', 'czarna': 'Črna', 'niebieski': 'Modra', 'niebieska': 'Modra',
    'biały': 'Bela', 'bialy': 'Bela', 'biała': 'Bela', 'biala': 'Bela',
    'szary': 'Siva', 'szara': 'Siva', 'zielony': 'Zelena', 'zielona': 'Zelena',
    'czerwony': 'Rdeča', 'czerwona': 'Rdeča',
    // Croatian
    'crna': 'Črna', 'crno': 'Črna', 'plava': 'Modra', 'bijela': 'Bela',
    'siva': 'Siva', 'crvena': 'Rdeča',
    // Hungarian
    'fekete': 'Črna', 'kék': 'Modra', 'kek': 'Modra', 'fehér': 'Bela', 'feher': 'Bela',
    'szürke': 'Siva', 'szurke': 'Siva', 'piros': 'Rdeča', 'zöld': 'Zelena', 'zold': 'Zelena',
    // Hungarian (extended)
    'barna': 'Rjava', 'bézs': 'Bež', 'bezs': 'Bež', 'sötétkék': 'Temno modra', 'sotetkek': 'Temno modra',
    'rózsaszín': 'Roza', 'rozsaszin': 'Roza', 'narancssárga': 'Oranžna', 'narancssarga': 'Oranžna',
    'lila': 'Vijolična', 'sárga': 'Rumena', 'sarga': 'Rumena', 'türkiz': 'Turkizna', 'turkiz': 'Turkizna',
    // Greek (extended)
    'Μαύρο': 'Črna', 'μαύρο': 'Črna', 'Μπλε': 'Modra', 'μπλε': 'Modra',
    'Λευκό': 'Bela', 'λευκό': 'Bela', 'Γκρι': 'Siva', 'γκρι': 'Siva',
    'Σκούρο μπλε': 'Temno modra', 'σκούρο μπλε': 'Temno modra',
    'Πράσινο': 'Zelena', 'πράσινο': 'Zelena', 'Κόκκινο': 'Rdeča', 'κόκκινο': 'Rdeča',
    'Μπεζ': 'Bež', 'μπεζ': 'Bež', 'Καφέ': 'Rjava', 'καφέ': 'Rjava',
    'Κίτρινο': 'Rumena', 'κίτρινο': 'Rumena', 'Ροζ': 'Roza', 'ροζ': 'Roza',
    'Μωβ': 'Vijolična', 'μωβ': 'Vijolična', 'Τυρκουάζ': 'Turkizna', 'τυρκουάζ': 'Turkizna',
    // Italian (extended)
    'nero': 'Črna', 'nera': 'Črna', 'blu': 'Modra', 'bianco': 'Bela', 'bianca': 'Bela',
    'grigio': 'Siva', 'grigia': 'Siva', 'rosso': 'Rdeča', 'rossa': 'Rdeča', 'verde': 'Zelena',
    'blu scuro': 'Temno modra', 'Blu scuro': 'Temno modra',
    'marrone': 'Rjava', 'beige': 'Bež', 'rosa': 'Roza', 'arancione': 'Oranžna',
    'viola': 'Vijolična', 'giallo': 'Rumena', 'gialla': 'Rumena', 'turchese': 'Turkizna',
    // Czech/Slovak extended
    'sivá': 'Siva', 'tmavě modrá': 'Temno modra', 'Tmavě modrá': 'Temno modra',
    'tmavě modrý': 'Temno modra', 'hnědá': 'Rjava', 'hneda': 'Rjava',
    'béžová': 'Bež', 'bezova': 'Bež', 'růžová': 'Roza', 'ruzova': 'Roza',
    'oranžová': 'Oranžna', 'oranzova': 'Oranžna', 'fialová': 'Vijolična', 'fialova': 'Vijolična',
    'žlutá': 'Rumena', 'zluta': 'Rumena', 'tyrkysová': 'Turkizna', 'tyrkysova': 'Turkizna',
    'tmavomodrá': 'Temno modra', 'tmavomodra': 'Temno modra',
    'svetlomodrá': 'Svetlo modra', 'svetlomodra': 'Svetlo modra',
    // Croatian extended
    'smeđa': 'Rjava', 'smeda': 'Rjava', 'bež': 'Bež', 'tamnoplava': 'Temno modra',
    'narančasta': 'Oranžna', 'narancasta': 'Oranžna', 'ljubičasta': 'Vijolična', 'ljubicasta': 'Vijolična',
    'žuta': 'Rumena', 'zuta': 'Rumena', 'tirkizna': 'Turkizna', 'tamno plava': 'Temno modra',
    // Polish extended
    'brązowy': 'Rjava', 'brazowy': 'Rjava', 'beżowy': 'Bež', 'bezowy': 'Bež',
    'różowy': 'Roza', 'rozowy': 'Roza', 'pomarańczowy': 'Oranžna', 'pomaranczowy': 'Oranžna',
    'fioletowy': 'Vijolična', 'żółty': 'Rumena', 'zolty': 'Rumena',
    'granatowy': 'Temno modra', 'turkusowy': 'Turkizna',
    // Romanian
    'negru': 'Črna', 'neagră': 'Črna', 'neagra': 'Črna',
    'albastru': 'Modra', 'albastră': 'Modra', 'albastra': 'Modra',
    // Modra - mnozina/skloni iz upsell fraz (4x modre bokserice, per-jezik)
    'modré': 'Modra', 'modre': 'Modra',           // CZ/SK "Modré boxerky" / HR-SK "Modre Boksarice"
    'plave': 'Modra', 'plavi': 'Modra',           // HR "Plave Bokserice"
    'niebieskie': 'Modra', 'niebieskei': 'Modra', // PL "Niebieskie bokserki"
    'albaștri': 'Modra', 'albastri': 'Modra', 'albaștrii': 'Modra', // RO "Boxeri Albaștri"
    'blaue': 'Modra', 'blauen': 'Modra',          // DE "Blaue Boxershorts"
    // Bela / ostale mnozinske oblike
    'bijele': 'Bela', 'bijeli': 'Bela', 'białe': 'Bela', 'biele': 'Bela',
    // CZ/SK majice "Jedno černé/šedé/čierne/sivé tričko"
    'černé': 'Črna', 'cerne': 'Črna', 'čierne': 'Črna', 'cierne': 'Črna',
    'šedé': 'Siva', 'sede': 'Siva', 'sivé': 'Siva', 'sive': 'Siva',
    'alb': 'Bela', 'albă': 'Bela', 'alba': 'Bela',
    'gri': 'Siva',
    'roșu': 'Rdeča', 'rosu': 'Rdeča', 'roșie': 'Rdeča', 'rosie': 'Rdeča',
    'verde': 'Zelena',
    'bleumarin': 'Temno modra',
    'maro': 'Rjava', 'maroniu': 'Rjava',
    'bej': 'Bež',
    'roz': 'Roza',
    'portocaliu': 'Oranžna',
    'mov': 'Vijolična', 'violet': 'Vijolična',
    'galben': 'Rumena', 'galbenă': 'Rumena', 'galbena': 'Rumena',
    'turcoaz': 'Turkizna',
    'bleumarin majica': 'Temno modra', 'Bleumarin Majica': 'Temno modra',
    'gri majica': 'Siva', 'Gri Majica': 'Siva',
    'negru majica': 'Črna', 'Negru Majica': 'Črna',
    'zelena majica': 'Zelena', 'Zelena Majica': 'Zelena',
    'maro majica': 'Rjava', 'Maro Majica': 'Rjava',
    // German
    'schwarz': 'Črna', 'Schwarz': 'Črna',
    'weiß': 'Bela', 'weiss': 'Bela', 'Weiß': 'Bela', 'Weiss': 'Bela',
    'grau': 'Siva', 'Grau': 'Siva',
    'blau': 'Modra', 'Blau': 'Modra',
    'rot': 'Rdeča', 'Rot': 'Rdeča',
    'grün': 'Zelena', 'grun': 'Zelena', 'Grün': 'Zelena', 'Grun': 'Zelena',
    'braun': 'Rjava', 'Braun': 'Rjava',
    'dunkelblau': 'Temno modra', 'Dunkelblau': 'Temno modra',
    'marineblau': 'Temno modra', 'Marineblau': 'Temno modra',
    'hellblau': 'Svetlo modra', 'Hellblau': 'Svetlo modra',
    'rosa': 'Roza', 'Rosa': 'Roza',
    'orange': 'Oranžna', 'Orange': 'Oranžna',
    'lila': 'Vijolična', 'Lila': 'Vijolična',
    'gelb': 'Rumena', 'Gelb': 'Rumena',
    'türkis': 'Turkizna', 'turkis': 'Turkizna', 'Türkis': 'Turkizna', 'Turkis': 'Turkizna',
    // Slovenian (pass through)
    'Črna': 'Črna', 'Modra': 'Modra', 'Bela': 'Bela', 'Siva': 'Siva',
    'Zelena': 'Zelena', 'Rdeča': 'Rdeča', 'Rjava': 'Rjava', 'Bež': 'Bež',
    'Temno modra': 'Temno modra', 'Tamnoplava': 'Temno modra', 'Smeđa': 'Rjava',
    'Roza': 'Roza', 'Oranžna': 'Oranžna', 'Vijolična': 'Vijolična', 'Rumena': 'Rumena',
    'Turkizna': 'Turkizna', 'Svetlo modra': 'Svetlo modra',
    // [2026-08-26 Dejan] Skladiscu se ne sme prikazati madzarska ali hrvaska beseda
    // za barvo — te oblike so prihajale skozi in bile prikazane surovo.
    'temnomodra': 'Temno modra', 'smedja': 'Rjava', 'verzi': 'Zelena', 'hnedá': 'Rjava', 'sötét kék': 'Temno modra',
};

function translateColorServer(color) {
    if (!color) return '';
    const trimmed = color.trim();
    // Direct match
    if (colorTranslationsServer[trimmed]) return colorTranslationsServer[trimmed];
    // Lowercase match
    const lower = trimmed.toLowerCase();
    if (colorTranslationsServer[lower]) return colorTranslationsServer[lower];
    // Unicode normalized match (strip accents for lookup)
    const normalized = lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    for (const [key, value] of Object.entries(colorTranslationsServer)) {
        const keyNorm = key.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (keyNorm === normalized) return value;
    }
    // Fraza-match: barva je vgnezdena v daljsi niz (npr grski upsell
    // "Ένα μαύρο μπλουζάκι" = "Ena crna majica" -> najdi barvno besedo znotraj).
    // Iscemo kljuc-besedo kot celo besedo; daljsi kljuci (npr "σκούρο μπλε")
    // imajo prednost pred krajsimi ("μπλε"), da ne zgresimo "temno modra".
    const keysByLen = Object.keys(colorTranslationsServer)
        .sort((a, b) => b.length - a.length);
    for (const key of keysByLen) {
        const kNorm = key.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
        if (kNorm.length < 3) continue; // preskoci prekratke (npr "l") -> lazni zadetki
        // meja besede: kljuc obdan z ne-crkovnim znakom ali robom niza
        const re = new RegExp('(^|[^\\p{L}])' + kNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\p{L}])', 'u');
        if (re.test(normalized)) return colorTranslationsServer[key];
    }
    // [2026-08-26 Dejan] SKLONI IN MNOZINA: Metakocka na mesto barve vcasih zapise
    // IME izdelka v drugem sklonu — npr. upsell "1 : Zelene Bokserice - 4XL".
    // "zelene" se ne ujema s kljucem "zelena", zato je taka postavka padla v
    // opozorilo "Neprevedena barva", cetudi je barva ocitna. Primerjamo KORENE:
    // kljucu odrezemo koncni samoglasnik in pogledamo, ali se katera beseda v
    // nizu zacne z njim (zelen- -> zelene, crn- -> crne, siv- -> sive).
    const besede = normalized.split(/[^\p{L}]+/u).filter(w => w.length >= 3);
    for (const key of keysByLen) {
        const kNorm = key.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
        if (kNorm.length < 4) continue;                     // prekratki kljuci delajo lazne zadetke
        const koren = kNorm.replace(/[aeiouy]$/, '');       // zelena -> zelen, crna -> crn
        if (koren.length < 3) continue;
        // beseda se mora zaceti s korenom in ne sme biti bistveno daljsa
        // (da "bel" ne pobere "belgija" ipd.)
        if (besede.some(w => w.startsWith(koren) && w.length <= koren.length + 3)) {
            return colorTranslationsServer[key];
        }
    }
    return trimmed;
}

// Helper: Parse doc_desc field to extract items
// [2026-08-19 Dejan] KNEEFIX (in podobni parni izdelki) imajo v doc_desc STRAN:
// "1 : Αριστερά - L (76-90 kg)" / "1 : Lijeva - M" / "1 : Desno - XL".
// Stran je za skladisce OBVEZEN podatek — brez nje ne morejo pakirati.
// Prepoznamo jo v vseh jezikih trgov in normaliziramo v "Leva" / "Desna".
const SIDE_LEFT_RE  = /(^|[^\p{L}])(lijev\p{L}*|ljev\p{L}*|lev\p{L}*|ľav\p{L}*|lav\p{L}*|left|links?|linke\p{L}*|bal|lew\p{L}*|st[âa]ng\p{L}*|αριστερ\p{L}*|sinistr\p{L}*)([^\p{L}]|$)/iu;
const SIDE_RIGHT_RE = /(^|[^\p{L}])(desn\p{L}*|prav\p{L}*|right|recht\p{L}*|jobb|praw\p{L}*|dreapt\p{L}*|δεξι\p{L}*|destr\p{L}*)([^\p{L}]|$)/iu;
function detectSide(raw) {
    const v = String(raw || '');
    if (SIDE_LEFT_RE.test(v)) return 'Leva';
    if (SIDE_RIGHT_RE.test(v)) return 'Desna';
    return '';
}
function parseDocDesc(docDesc, productCode, productName) {
    const code = (productCode || '').toUpperCase();
    const productType = getProductTypeFromCode(productCode, productName);
    
    // Extract size from doc_desc or product code
    let bundleSize = '';
    if (docDesc) {
        const sizeMatch = docDesc.match(/(?:velicina|velkost|rozmiar|size|méret|velikost|megethos|taglia|nagysag|nagyság|groesse|grösse|grosse|velicina-majice|velicina-bokseric|velkost-tricka|velkost-boxerek|megethos-mployzakia|megethos-mpoxer|meret|rozmer)\s*:\s*(\S+)/i);
        if (sizeMatch) bundleSize = sizeMatch[1].toUpperCase();
    }
    if (!bundleSize) {
        // Try from code: NORIKS-BOX-BLACK-3-PACK-XL → XL
        const codeSize = code.match(/-((?:\d*X*)?[SMLX]{1,3}L?)$/);
        if (codeSize) bundleSize = codeSize[1].toUpperCase();
    }
    
    // Check if this is a known bundle - match base code without size suffix
    const baseCode = code.replace(/-((?:\d*X*)?[SMLX]{1,3}L?)$/, '');

    // NORIKS-BOXERS-GRAY-2X-UPSELL-* = sidecart upsell "2x sive bokserice".
    // doc_desc nima ostevilcenih pozicij (samo "{jezik-size} _noriks_upsell : sidecart_upsell"),
    // zato bi navadni parser vrnil SAMO 1 kos + vcasih napacno velikost (suffix -2/-3/-X ni cist
    // -XL/-2XL). Eksplicitno: 2 sivi bokserici, velikost iz doc_desc ALI iz imena ("... - 3XL").
    if (code.includes('BOXERS-GRAY-2X-UPSELL')) {
        let gSize = bundleSize;
        const nameSize = (productName || '').match(/-\s*((?:\d?X)?[SMLX]{1,2}L?)\s*$/i);
        if ((!gSize || !/^(\d?X)?[SMLX]{1,2}L?$/i.test(gSize)) && nameSize) {
            gSize = nameSize[1].toUpperCase();
        }
        return [
            { type: 'Boksarice', color: 'Siva', size: gSize, noWarning: true },
            { type: 'Boksarice', color: 'Siva', size: gSize, noWarning: true },
        ];
    }
    const bundleFn = bundleContents[baseCode] || bundleContents[code];
    if (bundleFn && bundleSize) {
        return bundleFn(bundleSize);
    }
    
    // Name-based bundle matching (when code doesn't match known bundles)
    // Maps translated product names from Metakocka → bundle SKU
    const nameToBundleMap = {
        // CITY COMBO 6-PACK (all languages)
        'svakodnevni 6-paket': 'NORIKS-CITY-COMBO-6-PACK',
        'everyday 6-pack': 'NORIKS-CITY-COMBO-6-PACK',
        'pacchetto giornaliero 6': 'NORIKS-CITY-COMBO-6-PACK',
        'mindennapi 6-os csomag': 'NORIKS-CITY-COMBO-6-PACK',
        'každodenní balení 6': 'NORIKS-CITY-COMBO-6-PACK',
        'codzienny 6-pak': 'NORIKS-CITY-COMBO-6-PACK',
        'καθημερινό πακέτο 6': 'NORIKS-CITY-COMBO-6-PACK',
        'αστικό μιξ': 'NORIKS-CITY-COMBO-6-PACK',
        'gradski miks': 'NORIKS-CITY-COMBO-6-PACK',
        'městský mix': 'NORIKS-CITY-COMBO-6-PACK',
        'miejski mix': 'NORIKS-CITY-COMBO-6-PACK',
        'városi mix': 'NORIKS-CITY-COMBO-6-PACK',
        'mix urbano': 'NORIKS-CITY-COMBO-6-PACK',
        // MIDNIGHT 3-PACK (all languages)
        'ponoćni mix 3-paket': 'NORIKS-MIDNIGHT-3-PACK',
        'midnight 3-pack': 'NORIKS-MIDNIGHT-3-PACK',
        'μεσονύκτιο μιξ': 'NORIKS-MIDNIGHT-3-PACK',
        'ponoćni miks': 'NORIKS-MIDNIGHT-3-PACK',
        'mix mezzanotte': 'NORIKS-MIDNIGHT-3-PACK',
        'éjféli mix': 'NORIKS-MIDNIGHT-3-PACK',
        'půlnoční mix': 'NORIKS-MIDNIGHT-3-PACK',
        'północny mix': 'NORIKS-MIDNIGHT-3-PACK',
        // URBAN 3-PACK (all languages)
        'urbano-zemljani 3-paket': 'NORIKS-URBAN-3-PACK',
        'urban 3-pack': 'NORIKS-URBAN-3-PACK',
        'αστικό-γήινο': 'NORIKS-URBAN-3-PACK',
        'urbano-zemaljski': 'NORIKS-URBAN-3-PACK',
        'urbano-terroso': 'NORIKS-URBAN-3-PACK',
        'városi-földes': 'NORIKS-URBAN-3-PACK',
        'městsko-zemitý': 'NORIKS-URBAN-3-PACK',
        'miejsko-ziemisty': 'NORIKS-URBAN-3-PACK',
        // MONOCHROME 3-PACK (all languages)
        'monokromni 3-paket': 'NORIKS-MONOCHROME-3-PACK',
        'monochrome 3-pack': 'NORIKS-MONOCHROME-3-PACK',
        'μονόχρωμο': 'NORIKS-MONOCHROME-3-PACK',
        'monokromatski': 'NORIKS-MONOCHROME-3-PACK',
        'monocromatico': 'NORIKS-MONOCHROME-3-PACK',
        'monokróm': 'NORIKS-MONOCHROME-3-PACK',
        'monochromatický': 'NORIKS-MONOCHROME-3-PACK',
        'monochromatyczny': 'NORIKS-MONOCHROME-3-PACK',
        // COASTAL 3-PACK (all languages)
        'obalni 3-paket': 'NORIKS-COASTAL-3-PACK',
        'coastal 3-pack': 'NORIKS-COASTAL-3-PACK',
        'παραλιακό': 'NORIKS-COASTAL-3-PACK',
        'obalni miks': 'NORIKS-COASTAL-3-PACK',
        'costiero': 'NORIKS-COASTAL-3-PACK',
        'tengerparti': 'NORIKS-COASTAL-3-PACK',
        'pobřežní': 'NORIKS-COASTAL-3-PACK',
        'przybrzeżny': 'NORIKS-COASTAL-3-PACK',
    };
    const nameKey = (productName || '').toLowerCase().replace(/\s*-\s*[smlx0-9]+$/i, '').trim();
    for (const [pattern, bundleSku] of Object.entries(nameToBundleMap)) {
        if (nameKey.includes(pattern)) {
            const fn = bundleContents[bundleSku];
            if (fn && bundleSize) {
                return fn(bundleSize);
            }
        }
    }
    
    // UPSELL / NUMBERED-POSITION BUNDLE guard (npr NORIKS-BOXERS-BLUE-L z upsell 4-pack):
    // doc_desc oblike "velikost : L ... _noriks_upsell_pieces : 4 1 : Modre Boksarice - L 2 : ... 4 : ..."
    // Brez tega guarda bi singleProductColors (BOXERS-BLUE) vrnil SAMO 1 kos namesto 4.
    // Ce doc_desc vsebuje ostevilcene pozicije (\d+ : <barva> - <velikost>), jih naStejemo VSE.
    // NUMBERED-POSITION regex (deljen): "N : [Tip:] Barva - Velikost"
    // Tip lahko vsebuje vezaj (T-Shirt), velikost je XL-oblika ALI nogavicna (43-46).
    // Lookahead loci pozicije + izloci _meta (_bundle_pairs/_offer_id/_noriks_upsell...).
    const NUM_POS_RE = /(\d+)\s*:\s*(?:((?:(?!\s-\s)[^:_])+?)\s*:\s*)?((?:(?!\s-\s)[^:_])+?)\s*-\s*(\d{2,3}\s*-\s*\d{2,3}|\d*X*[SMLX]{1,3}L?(?:\/[SMLX]{1,3}L?)?(?:\s+\d{2,3}\s*-\s*\d{2,3})?)(?=\s+\d+\s*:|\s+_[a-zA-Z]|$)/g;
    if (docDesc && new RegExp(NUM_POS_RE.source).test(docDesc)) {
        const posItems = [];
        let pm; NUM_POS_RE.lastIndex = 0;
        while ((pm = NUM_POS_RE.exec(docDesc)) !== null) {
            let itemType = productType;
            if (pm[2]) { const tk = pm[2].trim(); itemType = typeTranslations[tk] || typeTranslations[tk.replace(/\s+\d+$/,'')] || tk; }
            const _side3 = detectSide(pm[3]); posItems.push({ type: itemType, color: _side3 || translateColorServer(pm[3].trim()), size: pm[4].replace(/\s+/g,' ').trim().toUpperCase() });
        }
        if (posItems.length >= 1) return posItems;
    }

    // SINGLE-ATTRIBUTE NUMBERED POSITIONS (npr NORIKS-ORTOPAS "1 : S/M (Opseg bokova 75-110 cm)",
    // NORIKS-KIDSNEST "1 : 3-9 godina 2 : 9-18 godina", NORIKS-KNEEFIX "1 : Desno - M (61-75 kg)").
    // Ti produkti so variacija SAMO po velikosti/starosti (brez "Barva - Velikost" para), zato
    // dash-based regexi zgoraj NE ujamejo -> prej padlo v generic fallback ("Ni bilo mogoce parsati").
    // Vsaka N-pozicija = 1 kos. STROGO: obdrzimo SAMO ce iz VSAKE pozicije zanesljivo izlusimo
    // velikost/starost; sicer bail-out (return []) da messy call-center/ime-only primeri OBDRZIJO
    // svoje rocno-preveri opozorilo. Teče SAMO ce dash-based NUM_POS_RE NI ujel.
    if (docDesc && !(new RegExp(NUM_POS_RE.source).test(docDesc))) {
        const singleClean = docDesc
            .replace(/_bundle_pairs\s*:.*$/is, '')
            .replace(/_offer_id\s*:.*$/is, '')
            .replace(/_cc_source\s*:.*$/is, '')
            .replace(/_noriks_upsell_pieces\s*:.*$/is, '')
            .replace(/\s+Discount\s*:.*$/is, '')
            .trim();
        // "N : <value>" pozicije kjer value NE vsebuje _meta niti naslednje "N :" pozicije
        const SINGLE_POS_RE = /(\d+)\s*:\s*((?:(?!\s+\d+\s*:)(?!\s+_[a-zA-Z])[^:_])+)/g;
        const singleItems = [];
        let sm, allSized = true; SINGLE_POS_RE.lastIndex = 0;
        while ((sm = SINGLE_POS_RE.exec(singleClean)) !== null) {
            const rawVal = sm[2].trim();
            if (!rawVal) continue;
            // Zanesljiva velikost: "S/M (Opseg...)" -> "S/M", "Desno - M (61-75 kg)" -> "M",
            // cist size token ("S/M","2XL 44-48"), ali starost/obseg range ("3-9 godina").
            let size = '';
            let color = '';
            // [2026-08-10] Orto izdelki imajo lahko pozicijo SAMO z barvo (npr. KOMZIPS "1 : Crna").
            // Prej je tak zapis padel v bail-out -> "Ni bilo mogoce parsati" cetudi je podatek OBSTAJAL.
            const COLOR_ONLY_RE = /^(crna|črna|black|nero|schwarz|fekete|czarny|černá|čierna|negru|μαύρο|bijela|bela|biela|white|weiss|weiß|fehér|biały|bílá|alb|λευκό|siva|sivá|szürke|szary|šedá|gri|grigio|grau|γκρι|bež|bez|beige|bézs|beżowy|béžová|bej|μπεζ|zelena|green|zöld|zielony|zelená|verde|πράσιν|plava|modra|blue|kék|niebieski|modrá|albastru|blu|μπλε)$/i;
            const sizeParen = rawVal.match(/(?:^|\s)([\dX]*[SMLX]{1,3}L?(?:\/[SMLX]{1,3}L?)?)\s*\(/i);
            const plainSize = /^[\dX]*[SMLX]{1,3}L?(?:\/[SMLX]{1,3}L?)?(?:\s+\d{2,3}-\d{2,3})?$/i;
            const ageRange = /\d+\s*[\u2013-]\s*\d+/.test(rawVal) &&
                /godin|godina|let|year|jahr|\u00e9v|lat|rok|χρον|χρόν|ani|anni|cm/i.test(rawVal);
            const _side = detectSide(rawVal);
            if (_side) color = _side;
            if (sizeParen) {
                size = sizeParen[1].toUpperCase().trim();
            } else if (plainSize.test(rawVal)) {
                size = rawVal.replace(/\s+/g, ' ').trim().toUpperCase();
            } else if (ageRange) {
                size = rawVal.replace(/\s+/g, ' ').trim();
            } else if (COLOR_ONLY_RE.test(rawVal.replace(/\s+/g, ' ').trim())) {
                // [2026-08-26 Dejan] Prej smo tu naredili samo veliko zacetnico, zato so
                // madzarske/hrvaske oblike ("bézs", "sötétkék") koncale na kartici surove.
                // Vrednost gre skozi isti prevajalnik kot vse ostale barve.
                const c = rawVal.replace(/\s+/g, ' ').trim();
                const prevedenaBarva = translateColorServer(c);
                color = (prevedenaBarva && prevedenaBarva !== c)
                    ? prevedenaBarva
                    : c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
            } else if (_side) {
                // pozicija vsebuje samo stran (npr. "1 : Lijeva") — to je veljaven podatek
            } else {
                allSized = false; // messy/ime-only pozicija -> ne prevzemi, pusti fallback opozorilo
                break;
            }
            singleItems.push({
                type: productType || getSlovenianName(code, productName) || 'Izdelek',
                color,
                size,
                noWarning: true
            });
        }
        if (allSized && singleItems.length > 0) return singleItems;
    }

    // Handle single product codes (e.g., NORIKS-ONE-DARKBLUE-4XL)
    const singleProductColors = {
        'ONE-DARKBLUE': 'Temno modra', 'ONE-BLACK': 'Črna', 'ONE-WHITE': 'Bela',
        'ONE-GREY': 'Siva', 'ONE-GREEN': 'Zelena', 'ONE-BLUE': 'Modra',
        'ONE-BROWN': 'Rjava', 'ONE-BEIGE': 'Bež', 'ONE-RED': 'Rdeča',
        // Boxers (single + upsell)
        'BOXERS-BLACK': 'Črna', 'BOXERS-GRAY': 'Siva', 'BOXERS-RED': 'Rdeča',
        'BOXERS-BLUE': 'Modra', 'BOXERS-GREEN': 'Zelena', 'BOXERS-WHITE': 'Bela',
        'BOXERS-DARKBLUE': 'Temno modra', 'BOXERS-BROWN': 'Rjava',
    };
    for (const [key, color] of Object.entries(singleProductColors)) {
        if (code.includes(key)) {
            const type = key.startsWith('BOXERS') ? (productType || 'Boksarice') : (productType || 'Majica');
            return [{ type, color, size: bundleSize }];
        }
    }
    
    // Handle socks — always show as 1 komplet (e.g., "1x Nogavice (5 parov)")
    if (code.includes('SOCKS')) {
        let pairCount = 1;
        const pcMatch = code.match(/(\d+)PC/i);
        if (pcMatch) pairCount = parseInt(pcMatch[1]);
        const nameMatch = productName.match(/(\d+)\s*par/i);
        if (nameMatch) pairCount = parseInt(nameMatch[1]);
        
        const sizeFromDesc = docDesc.match(/(?:velikost|velicina|rozmiar|size|méret|meret|groesse|grösse|grosse|nagysag)\s*:\s*(\S+)/i);
        // Nogavicna numericna velikost iz kode: NORIKS-SOCKS-BW-10PC-39-42 -> 39-42
        const sockCodeSize = code.match(/(\d{2,3}-\d{2,3})\s*$/);
        // Nogavicna numericna velikost iz imena: "... - 39-42" -> 39-42
        const sockNameSize = productName.match(/(\d{2,3}\s*-\s*\d{2,3})\s*$/);
        const sockSize = (sizeFromDesc ? sizeFromDesc[1] : '') || bundleSize || (sockCodeSize ? sockCodeSize[1] : '') || (sockNameSize ? sockNameSize[1].replace(/\s+/g, '') : '');
        
        // Determine color from code
        let sockColor = 'Črna'; // default
        if (code.includes('BW')) sockColor = 'Črna & Bela';
        else if (code.includes('WHITE')) sockColor = 'Bela';
        else if (code.includes('BLACK')) sockColor = 'Črna';
        
        // Return as single item showing komplet
        return [{ type: `Nogavice (${pairCount} parov)`, color: sockColor, size: sockSize }];
        // Note: previously returned individual pairs which was confusing for packing
    }
    
    // Handle BUNDLE products with dual sizes (shirts + boxers)
    if (code.includes('BUNDLE-SHIRTS-BOX') || code.includes('BUNDLE-SH-BOX')) {
        const items = [];
        if (docDesc) {
            // Match various language patterns for shirt/boxer sizes
            const shirtSize = docDesc.match(/(?:velikost-majice|velicina-majice|velkost-tricka|megethos-mployzakia|rozmiar-koszulki|meret-polo|rozmer-tricka|marimea-tricoului|marime-tricou)\s*:\s*(\S+)/i);   // [2026-08-25] SI: velikost-majice
            const boxerSize = docDesc.match(/(?:velikost-boksarice|velikost-boksaric|velicina-bokseric|velkost-boxerek|megethos-mpoxer|rozmiar-bokserki|meret-boxer|rozmer-boxerek|marimea-boxerilor|marime-boxeri)\s*:\s*(\S+)/i);   // [2026-08-25] SI: velikost-boksarice
            const sSize = shirtSize ? shirtSize[1].toUpperCase() : bundleSize;
            const bSize = boxerSize ? boxerSize[1].toUpperCase() : bundleSize;
            
            // Parse shirt and boxer counts - prefer product name over code
            let numShirts = 2, numBoxers = 5;
            const nameCountMatch = productName.match(/(\d+)\s*(?:majic|μπλουζ|koszul|tričk|póló|shirt)/i);
            const nameBoxerMatch = productName.match(/(\d+)\s*(?:bokser|μπόξερ|boxer)/i);
            if (nameCountMatch) numShirts = parseInt(nameCountMatch[1]);
            if (nameBoxerMatch) numBoxers = parseInt(nameBoxerMatch[1]);
            
            // Bundle color definitions by variant code (verified from WooCommerce descriptions)
            // 2+5 bundles:
            const bundleVariants_2_5 = {
                'P-1': { shirts: ['Črna', 'Bela'], boxers: ['Črna', 'Siva', 'Modra', 'Zelena', 'Rdeča'] },
                'P-2': { shirts: ['Črna', 'Modra'], boxers: ['Črna', 'Siva', 'Modra', 'Zelena', 'Rdeča'] },
                'P-3': { shirts: ['Siva', 'Bela'], boxers: ['Črna', 'Siva', 'Modra', 'Zelena', 'Rdeča'] },
                'P-4': { shirts: ['Črna', 'Siva'], boxers: ['Črna', 'Siva', 'Modra', 'Zelena', 'Rdeča'] },
            };
            // 5+5 bundles (verified from WC descriptions):
            const bundleVariants_5_5 = {
                'P-1': { shirts: ['Črna', 'Črna', 'Siva', 'Siva', 'Temno modra'], boxers: ['Črna', 'Siva', 'Modra', 'Zelena', 'Rdeča'] },
                'P-2': { shirts: ['Črna', 'Črna', 'Bela', 'Bela', 'Siva'], boxers: ['Črna', 'Siva', 'Modra', 'Zelena', 'Rdeča'] },
                'P-3': { shirts: ['Črna', 'Rjava', 'Bež', 'Zelena', 'Bela'], boxers: ['Črna', 'Siva', 'Modra', 'Zelena', 'Rdeča'] },
                'P-4': { shirts: ['Črna', 'Črna', 'Črna', 'Črna', 'Črna'], boxers: ['Črna', 'Črna', 'Črna', 'Črna', 'Črna'] },
            };
            // 4+10 bundles (verified from WC descriptions):
            const bundleVariants_4_10 = {
                'P-1': { shirts: ['Črna', 'Črna', 'Bela', 'Bela'], boxers: ['Črna', 'Črna', 'Siva', 'Siva', 'Modra', 'Modra', 'Zelena', 'Zelena', 'Rdeča', 'Rdeča'] },
                'P-2': { shirts: ['Črna', 'Črna', 'Temno modra', 'Temno modra'], boxers: ['Črna', 'Črna', 'Siva', 'Siva', 'Modra', 'Modra', 'Zelena', 'Zelena', 'Rdeča', 'Rdeča'] },
                'P-3': { shirts: ['Črna', 'Črna', 'Siva', 'Siva'], boxers: ['Črna', 'Črna', 'Siva', 'Siva', 'Modra', 'Modra', 'Zelena', 'Zelena', 'Rdeča', 'Rdeča'] },
                'P-4': { shirts: ['Črna', 'Siva', 'Temno modra', 'Bela'], boxers: ['Črna', 'Črna', 'Siva', 'Siva', 'Modra', 'Modra', 'Zelena', 'Zelena', 'Rdeča', 'Rdeča'] },
            };
            
            // Detect variant from code (e.g., SHIRTS-BOX-P-3-XL or SH-BOX-5-5-P-3-4)
            const variantMatch = code.match(/P-(\d)/);
            const variant = variantMatch ? `P-${variantMatch[1]}` : null;
            
            // Detect bundle size from code
            const isLargeBundle = code.includes('SH-BOX-4-10') || code.includes('SHIRTS-BOX-4-10');
            const is5_5Bundle = code.includes('SH-BOX-5-5') || code.includes('SHIRTS-BOX-5-5');
            
            let colors;
            if (isLargeBundle) {
                numShirts = 4; numBoxers = 10;
                colors = bundleVariants_4_10[variant] || bundleVariants_4_10['P-4'];
            } else if (is5_5Bundle) {
                numShirts = 5; numBoxers = 5;
                colors = bundleVariants_5_5[variant] || bundleVariants_5_5['P-2'];
            } else {
                // 2+5 default
                colors = bundleVariants_2_5[variant] || { shirts: ['Črna', 'Bela'], boxers: ['Črna', 'Siva', 'Modra', 'Zelena', 'Rdeča'] };
            }
            
            // Fallback to code pattern if name didn't provide counts
            if (!nameCountMatch && !nameBoxerMatch && !isLargeBundle && !is5_5Bundle) {
                const countMatch = code.match(/(?:SH-BOX|SHIRTS-BOX)-(\d+)-(\d+)/i);
                if (countMatch) {
                    numShirts = parseInt(countMatch[1]);
                    numBoxers = parseInt(countMatch[2]);
                }
            }
            
            const shirtColors = colors.shirts;
            const boxerColors = colors.boxers;
            
            for (let n = 0; n < numShirts; n++) {
                items.push({ type: 'Majica', color: shirtColors[n % shirtColors.length], size: sSize });
            }
            for (let n = 0; n < numBoxers; n++) {
                items.push({ type: 'Boksarice', color: boxerColors[n % boxerColors.length], size: bSize });
            }
        }
        if (items.length > 0) return items;
    }
    
    // Parse doc_desc for Starter packs and other items with detailed descriptions
    if (docDesc) {
        const items = [];
        // Clean up metadata
        let cleanDesc = docDesc.replace(/_bundle_pairs\s*:.*$/i, '').replace(/_offer_id\s*:.*$/i, '').trim();
        
        // Pattern: "1 : Type: Color - Size" or "1 : Color - Size"
        // Also handles Greek + SHGIFTS (tip z vezajem T-Shirt, nogavicna velikost 43-46).
        const regex = /(\d+)\s*:\s*(?:((?:(?!\s-\s)[^:_])+?)\s*:\s*)?((?:(?!\s-\s)[^:_])+?)\s*-\s*(\d{2,3}\s*-\s*\d{2,3}|\d*X*[SMLX]{1,3}L?(?:\/[SMLX]{1,3}L?)?(?:\s+\d{2,3}\s*-\s*\d{2,3})?)(?=\s+\d+\s*:|\s+_[a-zA-Z]|$)/g;
        let match;
        
        while ((match = regex.exec(cleanDesc)) !== null) {
            let itemType = productType;
            if (match[2]) {
                const typeKey = match[2].trim();
                itemType = typeTranslations[typeKey] || typeTranslations[typeKey.replace(/\s+\d+$/,'')] || typeKey;
            }
            
            const rawColor = match[3].trim();
            const color = translateColorServer(rawColor);
            const size = match[4].replace(/\s+/g,' ').trim().toUpperCase();
            
            items.push({ type: itemType, color, size });
        }
        
        if (items.length > 0) return items;
        
        // Simpler format: just size
        if (bundleSize) {
            // Check if product name/code indicates a multi-pack (e.g., "10-paket", "5-pack", "3-paket")
            const packMatch = (productName + ' ' + productCode).match(/(\d+)\s*[-–]?\s*(?:paket|pack|csomag|balen[ií]|pak|πακέτο|pacchetto|sada)/i);
            if (packMatch) {
                const packCount = parseInt(packMatch[1]);
                if (packCount > 1 && packCount <= 30) {
                    // Try to extract color from product name (e.g., "Crne bokserice 10-paket" → "crne" → "Črna")
                    const firstWord = (productName || '').split(/\s+/)[0] || '';
                    const colorFromName = translateColorServer(firstWord.toLowerCase());
                    const color = (colorFromName && colorFromName !== firstWord) ? colorFromName : '';
                    const items = [];
                    for (let i = 0; i < packCount; i++) {
                        items.push({ type: productType || productName, color, size: bundleSize });
                    }
                    return items;
                }
            }
            return [{ type: productType || productName, color: '', size: bundleSize }];
        }
    }
    
    // ORTO products without doc_desc — flag as missing data (shows red)
    if (code.includes('ORTO') && !docDesc) {
        return [{ type: productType || 'Majica', color: 'Ni podatka', size: bundleSize || 'Ni podatka' }];
    }
    
    return [];
}

// Helper: Get product type from code
function getProductTypeFromCode(code, name) {
    const codeUpper = (code || '').toUpperCase();
    const nameLower = (name || '').toLowerCase();
    
    if (codeUpper.includes('BOXERS') || nameLower.includes('bokser') || nameLower.includes('boxerk')) {
        return 'Boksarice';
    }
    if (codeUpper.includes('SHIRTS') || codeUpper.includes('MAJIC') || nameLower.includes('majic') || nameLower.includes('tričk') || nameLower.includes('tričko')) {
        return 'Majica';
    }
    if (codeUpper.includes('STARTER')) {
        return 'Starter paket';
    }
    if (codeUpper.includes('SOCKS') || codeUpper.includes('KOMZIPS') || nameLower.includes('nogavic') || nameLower.includes('ponožk') || nameLower.includes('čarap') || nameLower.includes('carap')) {
        return 'Nogavice';
    }
    if (codeUpper.includes('KOMPSFIT')) {
        return 'Majica';
    }
    return '';
}
// WooCommerce store credentials
const wcStores = {
    hr: { url: 'https://noriks.com/hr', ck: 'ck_ff08e90a8ff90be9f7fdfe7badfd4fdaa456d86b', cs: 'cs_0c36e01e44e488ae9d8a931b591a4d52584d975f' },
    cz: { url: 'https://noriks.com/cz', ck: 'ck_396d624acec5f7a46dfcfa7d2a74b95c82b38962', cs: 'cs_2a69c7ad4a4d118a2b8abdf44abdd058c9be9115' },
    pl: { url: 'https://noriks.com/pl', ck: 'ck_8fd83582ada887d0e586a04bf870d43634ca8f2c', cs: 'cs_f1bf98e46a3ae0623c5f2f9fcf7c2478240c5115' },
    sk: { url: 'https://noriks.com/sk', ck: 'ck_1abaeb006bb9039da0ad40f00ab674067ff1d978', cs: 'cs_32b33bc2716b07a738ff18eb377a767ef60edfe7' },
    hu: { url: 'https://noriks.com/hu', ck: 'ck_e591c2a0bf8c7a59ec5893e03adde3c760fbdaae', cs: 'cs_d84113ee7a446322d191be0725c0c92883c984c3' },
    gr: { url: 'https://noriks.com/gr', ck: 'ck_2595568b83966151e08031e42388dd1c34307107', cs: 'cs_dbd091b4fc11091638f8ec4c838483be32cfb15b' },
    it: { url: 'https://noriks.com/it', ck: 'ck_84a1e1425710ff9eeed69b100ed9ac445efc39e2', cs: 'cs_81d25dcb0371773387da4d30482afc7ce83d1b3e' },
    de: { url: 'https://noriks.com/de', ck: 'ck_aa7a83a913953447892295072cecb7ad7bb2b700', cs: 'cs_9feaecca33c0df3213abfbbb454ba00a1bdbc3f3' },
    si: { url: 'https://noriks.com/si', ck: 'ck_8fe81e37ac7c8aca9fe47ac3bbe27482d62d2e32', cs: 'cs_0be037bb7bf9a92ed7f886c5ceb9dd279f564900' },
    ro: { url: 'https://noriks.com/ro', ck: 'ck_69ef14e1be3423cb74613c64ce4243e8c47e0e00', cs: 'cs_a00df9b005bb9e964df5e3bf3af816b9c49a9423' },
    bg: { url: 'https://noriks.com/bg', ck: 'ck_da0017d35633e592ea20fc464aa3b4109ccdf5c2', cs: 'cs_51d455b0232cff26cf9e3645ef1c989b674975ac' },
    // EN / global store (noriks.com without country prefix) — TODO: fill in real WooCommerce ck/cs
    en: { url: 'https://noriks.com', ck: 'ck_b720bdc96d86124c7d9ec869c3f261015d1e6495', cs: 'cs_1fe2c5915aec85743cf4b8b943e536e392b15478' },
};

// Verify bundles endpoint - analyze WC product images vs our definitions
app.get('/api/packing/verify-bundles', async (req, res) => {
    try {
        const skus = Object.keys(bundleContents);
        const uniqueBaseSKUs = [...new Set(skus.map(s => s.replace(/-((?:\d*X*)?[SMLX]{1,3}L?)$/, '')))];
        
        // Fetch all products from HR store first (most complete)
        const hrCreds = wcStores.hr;
        const wcProductMap = {};
        
        // Batch: fetch 100 products at a time by searching
        console.log(`[Verify] Fetching ${uniqueBaseSKUs.length} unique SKUs from WC...`);
        const batchPromises = uniqueBaseSKUs.map(async (baseSku) => {
            try {
                const wcRes = await fetch(`${hrCreds.url}/wp-json/wc/v3/products?sku=${baseSku}&per_page=1`, {
                    headers: { 'Authorization': 'Basic ' + Buffer.from(`${hrCreds.ck}:${hrCreds.cs}`).toString('base64') }
                });
                const data = await wcRes.json();
                if (data.length > 0) wcProductMap[baseSku] = { product: data[0], store: 'hr' };
            } catch (e) {}
        });
        
        await Promise.all(batchPromises);
        console.log(`[Verify] Found ${Object.keys(wcProductMap).length} products in WC`);
        
        const results = skus.map(sku => {
            const currentItems = bundleContents[sku]('TEST');
            const currentSummary = {};
            currentItems.forEach(item => {
                const key = `${item.color} ${item.type}`;
                currentSummary[key] = (currentSummary[key] || 0) + 1;
            });
            
            const baseSku = sku.replace(/-((?:\d*X*)?[SMLX]{1,3}L?)$/, '');
            const wc = wcProductMap[baseSku];
            const wcProduct = wc?.product;
            
            return {
                sku,
                name: wcProduct?.name || sku,
                store: wc?.store || null,
                imageUrl: wcProduct?.images?.[0]?.src || null,
                description: (wcProduct?.short_description || '').replace(/<[^>]+>/g, ''),
                meta: {
                    numShirts: wcProduct?.meta_data?.find(m => m.key === 'number_of_shirts_in_this_product')?.value || null,
                },
                currentDefinition: currentSummary,
                totalItems: currentItems.length,
                type: currentItems[0]?.type || 'Unknown',
            };
        });
        
        res.json({ bundles: results, count: results.length });
    } catch (e) {
        console.error('[Verify] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Analyze a single bundle image with GPT-4o vision
app.post('/api/packing/analyze-bundle', async (req, res) => {
    const { imageUrl, productName, expectedCount } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });
    
    try {
        const OPENAI_KEY = process.env.OPENAI_API_KEY;
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: `This is a product image for "${productName}" which should contain ${expectedCount} items. Count EVERY item visible and list each color with exact count. Available colors are: Črna (black), Bela (white), Siva (grey), Tamnoplava (navy blue), Zelena (olive green), Smeđa (brown/camel), Bež (cream/beige), Modra (blue), Rdeča (red). Respond ONLY with JSON: {"items": [{"color": "Črna", "type": "Majica", "count": 2}, ...], "total": 9, "confidence": "high/medium/low"}` },
                        { type: 'image_url', image_url: { url: imageUrl } }
                    ]
                }],
                max_tokens: 500
            })
        });
        
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';
        // Extract JSON from response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            res.json(JSON.parse(jsonMatch[0]));
        } else {
            res.json({ raw: content, error: 'Could not parse JSON' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Save verified bundle definition
app.post('/api/packing/save-bundle', async (req, res) => {
    // This would write to a JSON file that overrides hardcoded definitions
    const { sku, items } = req.body;
    if (!sku || !items) return res.status(400).json({ error: 'sku and items required' });
    
    try {
        const overridesPath = path.join(__dirname, 'data', 'bundle-overrides.json');
        let overrides = {};
        try { overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8')); } catch(e) {}
        overrides[sku] = items;
        writeFileAtomic(overridesPath, JSON.stringify(overrides, null, 2));
        res.json({ ok: true, sku });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Health endpoint za monitoring (Telegram alert, skladisce check)
app.get('/api/packing/health', (req, res) => {
    const now = Date.now();
    const cache = readPackingCache();
    const keys = Object.keys(cache);
    const cacheEntries = keys.map(k => ({
        key: k,
        cachedAt: cache[k].cachedAt,
        ageSeconds: cache[k].cachedAt ? Math.round((now - new Date(cache[k].cachedAt).getTime())/1000) : null,
        orderCount: (cache[k].orders || []).length
    }));
    const oldestAge = cacheEntries.length ? Math.max(...cacheEntries.map(e => e.ageSeconds || 0)) : null;
    const newestAge = cacheEntries.length ? Math.min(...cacheEntries.map(e => e.ageSeconds || Infinity)) : null;
    const circuit = {
        open: isMetakockaCircuitOpen(),
        downUntil: metakockaDownUntil ? new Date(metakockaDownUntil).toISOString() : null,
        lastSuccess: metakockaLastSuccess ? new Date(metakockaLastSuccess).toISOString() : null,
        lastFail: metakockaLastFail ? new Date(metakockaLastFail).toISOString() : null,
        consecFails: metakockaConsecFails,
        secondsSinceLastSuccess: metakockaLastSuccess ? Math.round((now - metakockaLastSuccess)/1000) : null
    };
    const healthy = !circuit.open && (newestAge === null || newestAge < 1800); // < 30 min
    res.json({
        healthy, circuit, cache: { entries: cacheEntries, oldestAge, newestAge },
        timestamp: new Date().toISOString()
    });
});

// ============ END PACKING API ============

// Serve index.html for root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// ============ PACKING ORDERS CACHE WARMUP ============
// V ozadju vsakih 5 minut osvezi cache za 3 glavne statuse.
// UI tako vedno dobi sveze podatke iz cacha tudi ko Metakocka leze.
const PACKING_CACHE_DIR = path.join(__dirname, 'data');
const PACKING_CACHE_FILE = path.join(PACKING_CACHE_DIR, 'orders-cache.json');
const PACKING_CACHE_FRESH_MS = 5 * 60 * 1000; // 5 min - hitrejsa sveza narocila (Dejan 11.6.2026); circuit breaker se vedno scuva Metakocko
// [2026-08-14 Dejan] Dolgo okno (topsellers, 14 dni): svez 1 URO in warmup 1x na uro.
// (Dejan: "lahko je se ful pocasnejsi, na uro" — 14-dnevna slika se cez dan skoraj ne spremeni.)
// Packing zavihek OSTANE na 5 dneh / 5 min — njegova odzivnost se NE spremeni.
const PACKING_DAYS_DEFAULT = 10;
const PACKING_DAYS_MAX = 30; // [2026-08-18 Dejan] topsellers 30-dnevno okno (polnjenje ostane 14-dnevno)
const PACKING_LONG_DAYS = 14;
const PACKING_CACHE_FRESH_LONG_MS = 60 * 60 * 1000;
const PACKING_CACHE_STALE_CRITICAL_MS = 60 * 60 * 1000; // 60 min - nad to mejo banner=rdec

// Circuit breaker: ce Metakocka pada, NE klici je 2 min - vrni cache takoj.
const PACKING_CIRCUIT_OPEN_MS = 2 * 60 * 1000;
let metakockaDownUntil = 0;
let metakockaLastSuccess = 0;
let metakockaLastFail = 0;
let metakockaConsecFails = 0;
function isMetakockaCircuitOpen() { return Date.now() < metakockaDownUntil; }
function markMetakockaSuccess() {
    metakockaLastSuccess = Date.now();
    metakockaDownUntil = 0;
    if (metakockaConsecFails > 0) {
        console.log('[Packing/Circuit] CLOSED - Metakocka okrevana po ' + metakockaConsecFails + ' fail-ih');
        metakockaConsecFails = 0;
    }
}
function markMetakockaFail() {
    metakockaLastFail = Date.now();
    metakockaConsecFails++;
    metakockaDownUntil = Date.now() + PACKING_CIRCUIT_OPEN_MS;
    console.warn('[Packing/Circuit] OPEN za ' + (PACKING_CIRCUIT_OPEN_MS/1000) + 's (consec_fails=' + metakockaConsecFails + ')');
}

// === [2026-08-14 Dejan] KOTALECE SE 14-DNEVNO OKNO (za topsellers) ===
// Ideja: namesto da bi vsakic znova vlekli 14 dni iz Metakocke (pocasi, obremenjujoce),
// hranimo naracila v enem skladiscu po ID-ju in ga DOPOLNJUJEMO iz vsakega ze obstojecega
// 5-dnevnega sync-a (packing warmup vsakih ~5 min). Starejsa od 14 dni sproti brisemo.
// Rezultat: topsellers dobi odgovor TAKOJ iz datoteke, brez cakanja in brez dodatnih MK klicev.
// Enkrat na dan (04:00) se naredi polni 14-dnevni fetch — da se poberejo tudi spremembe
// statusov starejsih narocil in morebitna manjkajoca naracila.
// [2026-08-16 Dejan] Vir resnice za topsellers je zdaj SQLITE BAZA (topsellers-db.js).
// JSON ostane le kot enkratni uvoz ob prehodu.
const tsdb = require('./topsellers-db');
const ROLLING_FILE = path.join(__dirname, 'data', 'orders-rolling.json');
const ROLLING_DAYS = 14;
const ROTATE_DAYS = 30;   // [2026-08-19] rotacija sledi statusom cez cel 30-dnevni prikaz
function _dayStr(offsetDays) {
    const d = new Date(Date.now() + (offsetDays || 0) * 24 * 60 * 60 * 1000);
    return d.toISOString().split('T')[0];
}
function readRolling() {
    try {
        if (!fs.existsSync(ROLLING_FILE)) return { orders: {}, updatedAt: null };
        return JSON.parse(fs.readFileSync(ROLLING_FILE, 'utf8'));
    } catch (e) { return { orders: {}, updatedAt: null }; }
}
// VAROVALKE (2026-08-14): eno samo pokvarjeno narocilo (40886/2026: kolicina 1.110.111 kosov,
// total 33 mio EUR, status "Problem") je razpihnilo skladisce na 108 MB in upocasnilo vse.
// Zato: (1) naracila z absurdnim zneskom (>800 EUR, isto pravilo kot dash2) NE gredo v skladisce,
// (2) trdi pokrov na stevilo postavk, (3) shranimo samo polja, ki jih topsellers dejansko rabi.
const ROLL_MAX_EUR = 800;
const ROLL_MAX_ITEMS = 300;
const ROLL_RATES = { EUR: 1, CZK: 0.04112, PLN: 0.23565, HUF: 0.00278, HRK: 0.133, RON: 0.19111, BGN: 0.51 };
function _tooBigOrder(o) {
    const rate = ROLL_RATES[o.currency || 'EUR'] || 1;
    if ((parseFloat(o.total || 0) * rate) > ROLL_MAX_EUR) return true;
    let n = 0;
    for (const p of (o.products || [])) n += (p.items || []).length;
    return n > ROLL_MAX_ITEMS;
}
function slimForRolling(o) {
    return {
        id: o.id, customer: o.customer || '', country: o.country || '', status: o.status || '',
        date: o.date || '', time: o.time || '', orderDate: o.orderDate || '', orderTime: o.orderTime || '',
        shippedDate: o.shippedDate || '', total: o.total || '', currency: o.currency || 'EUR',
        wcId: o.wcId || '', mkId: o.mkId || '', eshop: o.eshopUrl || o._eshop || o.eshop || '',
        buyerOrder: o.buyerOrder || '', isExchange: !!o.isExchange,
        products: (o.products || []).map(p => ({
            label: p.label || '',
            items: (p.items || []).slice(0, ROLL_MAX_ITEMS).map(it => ({ type: it.type || '', color: it.color || '', size: it.size || '' }))
        }))
        // opomba: polje `items` (podvojen ravni seznam) NE gre v skladisce — kartice ga ne rabijo
    };
}
// Vsak uspesen MK fetch (5- ali 14-dnevni, tudi enodnevni) gre v BAZO — brez dodatnih klicev.
function mergeIntoRolling(orders) {
    if (!Array.isArray(orders) || !orders.length) return;
    try {
        const res = tsdb.upsertMany(orders);
        tsdb.prune();
        if (res.skipped) console.log(`[TopsellersDB] preskocenih ${res.skipped} absurdnih narocil (>${ROLL_MAX_EUR} EUR ali >${ROLL_MAX_ITEMS} postavk)`);
    } catch (e) {
        console.error('[TopsellersDB] upsert failed:', e.message);
    }
}

// [FAZA3.2] Cache zdaj zivi v SQLite (tsdb.cache*) — odpravljene read-modify-write
// dirke in 4MB JSON.parse na zahtevek. Podpisa funkcij NESPREMENJENA (6+ klicnih mest).
function readPackingCache() {
    try { return tsdb.cacheGetAll(); } catch (e) { return {}; }
}

function writePackingCacheEntry(cacheKey, orders) {
    try { tsdb.cacheSet(cacheKey, orders); }
    catch (e) { console.error('[Cache] set failed:', e.message); }
}

let BACKGROUND_WARMUP_RUNNING = false;
async function warmupPackingCache() {
    if (BACKGROUND_WARMUP_RUNNING) {
        console.log('[Packing/Warmup] Skipped - previous still running');
        return;
    }
    // Ce je circuit breaker open, ne kuri Metakocke - cakaj cooldown
    if (isMetakockaCircuitOpen()) {
        const waitMs = metakockaDownUntil - Date.now();
        console.log('[Packing/Warmup] Skipped - circuit breaker OPEN (' + Math.round(waitMs/1000) + 's preostalo)');
        return;
    }
    BACKGROUND_WARMUP_RUNNING = true;
    const t0 = Date.now();
    const statuses = ['Odpremljen', 'Novo', 'Pripravljen za odpremo'];
    const staleStatuses = () => {
        const all = readPackingCache();
        return statuses.filter(s => {
            const e = all[`orders_${s}_last3d`];
            return !(e && e.cachedAt && (Date.now() - new Date(e.cachedAt).getTime()) < PACKING_CACHE_FRESH_MS);
        });
    };
    const freshCount = () => statuses.length - staleStatuses().length;
    try {
        // EN SAM klic: handler zdaj iz enega MK fetcha napise vse 3 cache keye,
        // zato warmup ne rabi vec loop-a cez 3 statuse (3x manj MK obremenitve).
        const stale = staleStatuses();
        if (stale.length === 0) {
            console.log('[Packing/Warmup] Vsi 3 cache keyi svezi - skip');
            return;
        }
        try {
            // Pozeni fake express request skozi router — najlazji nacin za reuse celotne logike
            // (transformacija, enrichment, cache write). Mock req/res samo capture-a JSON odgovor.
            // _bg=1: dovoli dolge Metakocka timeoute (5 min/page) - samo background sme cakati
            // POMEMBNO: klici s PRVIM STALE statusom — ce bi klicali s svezim, handler vrne
            // cache takoj in ostala 2 keya nikoli ne dobita refresha.
            const status = stale[0];
            const mockReq = { query: { status, limit: '500', _bg: '1' }, method: 'GET', url: `/api/packing/orders?status=${encodeURIComponent(status)}&_bg=1` };
            await new Promise((resolve) => {
                let resolved = false;
                const mockRes = {
                    setHeader: () => {},
                    status: function(code) { this._status = code; return this; },
                    json: function(d) { if (!resolved) { resolved = true; resolve({ status: this._status || 200, data: d }); } }
                };
                // Najdemo handler
                const stack = app._router && app._router.stack || [];
                const route = stack.find(l => l.route && l.route.path === '/api/packing/orders');
                if (!route) { resolve({ status: 500, data: { error: 'no route' } }); return; }
                const handler = route.route.stack[0].handle;
                Promise.resolve(handler(mockReq, mockRes, () => {})).catch(e => {
                    if (!resolved) { resolved = true; resolve({ status: 500, data: { error: e.message } }); }
                });
                // 30 min safety - background fetch cez nocno-degradirano Metakocko (5 min/page)
                // legitimno rabi 10-25 min; prej je 60s cap obupal in cache se ponoci NIKOLI ni osvezil
                setTimeout(() => { if (!resolved) { resolved = true; resolve({ status: 504, data: { error: 'warmup timeout' } }); } }, 30 * 60 * 1000);
            });
        } catch (e) {
            console.error('[Packing/Warmup] Fetch failed:', e.message);
        }
        console.log('[Packing/Warmup] Done in ' + (Date.now()-t0) + 'ms, fresh=' + freshCount() + '/' + statuses.length);
    } finally {
        BACKGROUND_WARMUP_RUNNING = false;
    }
}

// [2026-08-14 Dejan] WARMUP ZA DOLGO OKNO (topsellers, 14 dni) — LOCEN od packing warmupa.
// Pravila, da se odzivnost packinga NE poslabsa:
//   - nikoli ne tece hkrati s packing warmupom (ta ima prednost),
//   - preskoci, ce je circuit breaker odprt ali je cache se svez (12 min),
//   - en sam MK fetch napolni vse 3 statusne kljuce (orders_<status>_last14d).
let LONG_WARMUP_RUNNING = false;
// BACKFILL: en poln 14-dnevni fetch (do 120 strani) -> napolni kotalece se skladisce.
// Tece SAMO: (a) ob zagonu, ce skladisce ne pokriva celega okna, (b) vsak dan ob 04:00,
// (c) na zahtevo, ce uporabnik odpre topsellers in okno se ni pokrito.
// Med dnevom skladisce sproti dopolnjujejo redni 5-dnevni packing sync-i (brez dodatnih MK klicev).
async function backfillRolling(days, opts) {
    const manual = !!(opts && opts.manual);
    const d = Math.min(days || PACKING_LONG_DAYS, PACKING_DAYS_MAX);
    // [2026-08-19 Dejan] ROCNI "Poln sync" je PREJ TIHO ODSTOPIL, ce je ravno tekel warmup
    // (ta tece vsakih 90 s po ~46 s -> priblizno vsak drugi klik ni naredil nicesar,
    // endpoint pa je vseeno vrnil {started:true}). Zdaj rocni klic POCAKA na warmup.
    if (manual) {
        for (let i = 0; i < 60 && (LONG_WARMUP_RUNNING || BACKGROUND_WARMUP_RUNNING); i++) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    if (LONG_WARMUP_RUNNING || BACKGROUND_WARMUP_RUNNING) { tsdb.setMeta('lastFullSyncResult', 'preskocen: warmup tece'); return; }
    if (isMetakockaCircuitOpen()) { tsdb.setMeta('lastFullSyncResult', 'preskocen: Metakocka nedosegljiva'); return; }
    // Cooldown: tudi ce vec uporabnikov odpre topsellers, backfill ne stece veckrat kot na 10 min.
    // Rocni klik ta cooldown obide — uporabnik ga je namenoma sprozil.
    if (!manual && global._lastBackfillAt && Date.now() - global._lastBackfillAt < 10 * 60 * 1000) { tsdb.setMeta('lastFullSyncResult', 'preskocen: cooldown 10 min'); return; }
    global._lastBackfillAt = Date.now();
    LONG_WARMUP_RUNNING = true;
    const t0 = Date.now();
    try {
        const status = 'Odpremljen';   // en fetch pokrije vse statuse (handler jih razdeli)
        const mockReq = { query: { status, limit: '20000', days: String(d), _bg: '1', force: '1' }, method: 'GET',
                          url: `/api/packing/orders?status=${encodeURIComponent(status)}&days=${d}&_bg=1&force=1` };
        await new Promise((resolve) => {
            let resolved = false;
            const mockRes = {
                setHeader: () => {},
                status: function (code) { this._status = code; return this; },
                json: function (dd) { if (!resolved) { resolved = true; resolve({ status: this._status || 200, data: dd }); } }
            };
            const stack = (app._router && app._router.stack) || [];
            const route = stack.find(l => l.route && l.route.path === '/api/packing/orders');
            if (!route) { resolve({ status: 500 }); return; }
            Promise.resolve(route.route.stack[0].handle(mockReq, mockRes, () => {}))
                .catch(e => { if (!resolved) { resolved = true; resolve({ status: 500, data: { error: e.message } }); } });
            setTimeout(() => { if (!resolved) { resolved = true; resolve({ status: 504 }); } }, 30 * 60 * 1000);
        });
        const cov = tsdb.coverage(d);
        console.log(`[TopsellersDB] Polni uvoz koncan v ${Date.now() - t0}ms — v bazi ${cov.total} narocil, ${Object.keys(cov.byDay).length} dni, od ${cov.oldest || '-'}`);
        tsdb.setMeta('lastFullSyncResult', `OK — ${d} dni, ${Math.round((Date.now() - t0) / 1000)} s, v bazi ${cov.total} narocil`);
    } catch (e) {
        console.error(`[Packing/Backfill${d}d] Failed:`, e.message);
        tsdb.setMeta('lastFullSyncResult', 'NAPAKA: ' + e.message);
    } finally {
        LONG_WARMUP_RUNNING = false;
    }
}
// Nazaj-zdruzljiv alias (starejsi klici v kodi).
const warmupLongWindow = backfillRolling;

// === PAMETNO POLNJENJE SKLADISCA (varcno do Metakocke) ===
// 1) POLNI 14-dnevni fetch se izvede SAMO, ce skladisce ni pokrito (prvi zagon / dolg izpad).
//    Zascita: najvec 1x na 24 h (_lastFullBackfillTs).
// 2) Nato se skladisce vzdrzuje INKREMENTALNO — brez enega samega dodatnega MK klica:
//    redni 5-dnevni packing sync (vsakih ~5 min) ob vsakem uspehu dopolni skladisce.
// 3) Ce v oknu vseeno manjka kaksen dan (npr. app je bil ugasnjen), ga doplacamo POSAMICNO
//    (fetch samo za tisti datum = par strani), najvec 2 dneva na uro. Nikoli cel 14-dnevni fetch.
async function fetchOneDayIntoRolling(day) {
    if (LONG_WARMUP_RUNNING || BACKGROUND_WARMUP_RUNNING || isMetakockaCircuitOpen()) return false;
    LONG_WARMUP_RUNNING = true;
    try {
        const mockReq = { query: { status: 'Odpremljen', limit: '5000', date: day, _bg: '1', force: '1' }, method: 'GET',
                          url: `/api/packing/orders?date=${day}&_bg=1&force=1` };
        await new Promise((resolve) => {
            let done = false;
            const mockRes = { setHeader: () => {}, status: function (c) { this._s = c; return this; },
                              json: function () { if (!done) { done = true; resolve(); } } };
            const stack = (app._router && app._router.stack) || [];
            const route = stack.find(l => l.route && l.route.path === '/api/packing/orders');
            if (!route) { resolve(); return; }
            Promise.resolve(route.route.stack[0].handle(mockReq, mockRes, () => {})).catch(() => { if (!done) { done = true; resolve(); } });
            setTimeout(() => { if (!done) { done = true; resolve(); } }, 10 * 60 * 1000);
        });
        console.log('[Packing/Rolling] doplacan dan ' + day);
        return true;
    } catch (e) {
        console.error('[Packing/Rolling] dan ' + day + ' ni uspel:', e.message);
        return false;
    } finally { LONG_WARMUP_RUNNING = false; }
}
async function maintainRolling() {
    const cov = tsdb.coverage(ROLLING_DAYS);
    // 1) POLNI 14-dnevni uvoz: samo ce je baza prazna / manjka vec kot pol okna. Max 1x/24h.
    if (cov.total < 200 || cov.missing.length > 7) {
        const lastTs = parseInt(tsdb.getMeta('lastFullSyncTs') || '0', 10);
        if (Date.now() - lastTs > 24 * 60 * 60 * 1000) {
            console.log('[TopsellersDB] POLNI 14-dnevni uvoz (v bazi=' + cov.total + ', manjka dni=' + cov.missing.length + ')');
            tsdb.setMeta('lastFullSyncTs', String(Date.now()));
            await backfillRolling(ROLLING_DAYS).catch(() => {});
            tsdb.setMeta('lastFullSync', new Date().toISOString());
        } else {
            console.log('[TopsellersDB] polni uvoz preskocen (opravljen v zadnjih 24 h)');
        }
        return;
    }
    // 2) Manjkajoci dnevi imajo prednost — doplacamo POSAMICNO (poceni, par strani).
    if (cov.missing.length) {
        for (const day of cov.missing.slice(0, 2)) {
            await fetchOneDayIntoRolling(day);
            await new Promise(r => setTimeout(r, 3000));
        }
        return;
    }
    // 3) SLEDENJE SPREMEMBAM STATUSOV pri starejsih narocilih (DELAY -> Odpremljen ipd.).
    //    Dneve 0-4 pokriva redni 5-dnevni sync (vsakih ~5 min). Za dneve 5..13 tu izberemo
    //    EN dan na tek — tistega, ki ima najvec se "zivih" narocil in ni bil najdlje osvezen.
    //    Tek je vsakih 10 min => cel rep (9 dni) se osvezi v ~1,5 ure, strosek ~6 poceni klicev/h
    //    (za primerjavo: redni packing warmup naredi ~275 strani/h — to je ~9 % dodatka).
    // [2026-08-19 Dejan] Prikaz je 30-dnevni, zato mora rotacija pokriti VSEH 30 dni.
    // Prej je segala samo do 13. dneva -> naročila, starejša od 14 dni, se NIKOLI niso
    // osvezila in so obvisela v starem statusu (DELAY namesto Odpremljen).
    // Ritem ostaja EN dan na tek (vsakih 10 min) -> cel rep v ~4,5 h, brez dodatnih MK klicev.
    const pending = tsdb.pendingByDay(ROTATE_DAYS);
    let best = null, bestScore = -1;
    for (let i = 3; i < ROTATE_DAYS; i++) {
        const day = tsdb.dayStr(-i);
        const p = pending[day] || 0;
        const lastTs = parseInt(tsdb.getMeta('dayRef:' + day) || '0', 10);
        const ageMin = (Date.now() - lastTs) / 60000;
        if (ageMin < 20) continue;                       // ta dan smo pravkar osvezili
        // Prioriteta: koliko zivih narocil ima * kako dolgo ni bil osvezen.
        const score = (p + 1) * Math.min(ageMin, 24 * 60);
        if (score > bestScore) { bestScore = score; best = { day, p }; }
    }
    // [2026-08-19 Dejan] VAROVALKA PROTI STRADANJU: sveži dnevi imajo 800-1000 živih naročil,
    // stari pa 20-60, zato bi jih ocena skoraj vedno prehitela. Če kateri dan ni bil na vrsti
    // vec kot 6 ur, ima BREZPOGOJNO prednost — s tem je najslabsi primer ~6 h, ne "nikoli".
    let starved = null, starvedAge = 6 * 60;
    for (let i = 3; i < ROTATE_DAYS; i++) {
        const day = tsdb.dayStr(-i);
        const ts = parseInt(tsdb.getMeta('dayRef:' + day) || '0', 10);
        const ageMin = ts ? (Date.now() - ts) / 60000 : 99999;
        // >= (ne >): pri enaki starosti (npr. vec dni se ni bilo nikoli na vrsti) zmaga
        // NAJSTAREJSI dan, ker se zanka vrti od najnovejsega proti najstarejsemu.
        if (ageMin >= starvedAge) { starvedAge = ageMin; starved = { day, p: pending[day] || 0 }; }
    }
    if (starved) best = starved;
    if (!best) return;
    const ok = await fetchOneDayIntoRolling(best.day);
    if (ok) {
        tsdb.setMeta('dayRef:' + best.day, String(Date.now()));
        tsdb.setMeta('lastDayRefresh', best.day + ' (zivih ' + best.p + ') @ ' + new Date().toISOString());
    }
}
// [2026-08-16 FAZA1] HEALTH CHECK za watchdog in monitoring.
// Vrne ok:false, ce katerakoli kriticna komponenta ne dela. BREZ obcutljivih podatkov.
app.get('/api/health', (req, res) => {
    const checks = {};
    let ok = true;
    // 1) topsellers baza berljiva in pokrita
    try {
        const cov = tsdb.coverage(ROLLING_DAYS);
        checks.db = { ok: cov.total > 100 && cov.missing.length <= 2, orders: cov.total, missingDays: cov.missing.length };
    } catch (e) { checks.db = { ok: false, error: e.message }; }
    // 2) packing cache svezina (redni sync tece?)
    try {
        const all = readPackingCache();
        const e = all['orders_Odpremljen_last3d'];
        const ageMin = e && e.cachedAt ? Math.round((Date.now() - new Date(e.cachedAt).getTime()) / 60000) : null;
        checks.cache = { ok: ageMin !== null && ageMin < 30, ageMin };
    } catch (e) { checks.cache = { ok: false, error: e.message }; }
    // 3) packed-orders datoteka berljiva (kriticni podatek skladisca)
    try {
        const n = packedMod.count();
        checks.packed = { ok: n > 0, entries: n };
    } catch (e) { checks.packed = { ok: false, error: e.message }; }
    // 4) disk zapisljiv (atomicni zapisi ga rabijo)
    try {
        const t = path.join(__dirname, 'data', '.health-probe');
        fs.writeFileSync(t, String(Date.now())); fs.unlinkSync(t);
        checks.disk = { ok: true };
    } catch (e) { checks.disk = { ok: false, error: e.message }; }
    checks.metakockaCircuit = { ok: !isMetakockaCircuitOpen() };   // info: odprt breaker ni fatalen (cache streze)
    ok = checks.db.ok && checks.cache.ok && checks.packed.ok && checks.disk.ok;
    res.status(ok ? 200 : 503).json({ ok, uptimeMin: Math.round(process.uptime() / 60), rssMb: Math.round(process.memoryUsage().rss / 1048576), checks });
});

// [2026-08-16] Rocni sprozilec polnega 14-dnevnega uvoza — SAMO z lokalnega streznika
// (vzdrzevanje/diagnostika). Zunaj ni dosegljiv, zato ga nihce ne more zloradno sprozati.
app.get('/api/packing/topsellers-resync', (req, res) => {
    const ip = String(req.socket && req.socket.remoteAddress || '');
    if (!(ip.includes('127.0.0.1') || ip.includes('::1')) || req.headers['x-forwarded-for'] || req.headers['x-real-ip']) return res.status(403).json({ error: 'localhost only' });
    if (LONG_WARMUP_RUNNING) return res.json({ running: true, note: 'uvoz ze tece' });
    tsdb.setMeta('lastFullSyncTs', String(Date.now()));
    tsdb.setMeta('lastFullSyncResult', 'tece...');
    // Cel 30-dnevni prikaz (prej samo 14 dni -> starejsa narocila gumb ni osvezil).
    backfillRolling(ROTATE_DAYS, { manual: true })
        .then(() => tsdb.setMeta('lastFullSync', new Date().toISOString()))
        .catch(() => {});
    res.json({ started: true });
});

// [2026-08-16 Dejan] Gumb "⚡ Poln sync" na topsellers: rocno potegne vseh 14 dni v bazo.
// Zahteva prijavo (gre skozi requireAuth). Varovalka: ce je bil poln sync pred manj kot
// 2 min, ga ne ponovimo (da klikanje ne kuri Metakocke).
app.get('/api/packing/topsellers-sync', (req, res) => {
    if (LONG_WARMUP_RUNNING) return res.json({ running: true });
    const lastTs = parseInt(tsdb.getMeta('lastFullSyncTs') || '0', 10);
    const agoMin = Math.round((Date.now() - lastTs) / 60000);
    if (lastTs && agoMin < 2) return res.json({ skipped: true, agoMin });
    tsdb.setMeta('lastFullSyncTs', String(Date.now()));
    tsdb.setMeta('lastFullSyncResult', 'tece...');
    // [2026-08-20 Dejan] Cel 30-dnevni prikaz (prej 14 dni) + manual:true, da uvoz
    // POCAKA na warmup namesto da tiho odstopi (prej ~vsak drugi klik ni naredil nicesar).
    backfillRolling(ROTATE_DAYS, { manual: true })
        .then(() => tsdb.setMeta('lastFullSync', new Date().toISOString()))
        .catch(() => {});
    res.json({ started: true });
});
app.get('/api/packing/topsellers-sync-status', (req, res) => {
    const cov = tsdb.coverage(ROLLING_DAYS);
    res.json({ running: LONG_WARMUP_RUNNING, total: cov.total, days: Object.keys(cov.byDay).length,
               oldest: cov.oldest, missing: cov.missing, lastFullSync: tsdb.getMeta('lastFullSync') });
});

// Stanje baze (za nadzor) — prav tako samo lokalno.
app.get('/api/packing/topsellers-status', (req, res) => {
    const ip = String(req.socket && req.socket.remoteAddress || '');
    if (!(ip.includes('127.0.0.1') || ip.includes('::1')) || req.headers['x-forwarded-for'] || req.headers['x-real-ip']) return res.status(403).json({ error: 'localhost only' });
    const cov = tsdb.coverage(ROLLING_DAYS);
    res.json({ ...cov, running: LONG_WARMUP_RUNNING, lastFullSync: tsdb.getMeta('lastFullSync'), lastDayRefresh: tsdb.getMeta('lastDayRefresh') });
});

// Ob zagonu: enkratna selitev starega JSON skladisca v bazo (ce je baza se prazna).
try {
    tsdb.importFromJson(ROLLING_FILE);
    tsdb.cacheImportFromJson(path.join(__dirname, 'data', 'orders-cache.json'));
    const c0 = tsdb.coverage(ROLLING_DAYS);
    console.log('[TopsellersDB] pripravljena: ' + c0.total + ' narocil, ' + Object.keys(c0.byDay).length + ' dni, najstarejsi ' + (c0.oldest || '-'));
} catch (e) { console.error('[TopsellersDB] init:', e.message); }

// Prvi pregled 3 min po zagonu, nato vsakih 10 min (en poceni enodnevni klic ali nic).
setTimeout(() => {
    maintainRolling().catch(e => console.error('[TopsellersDB]', e.message));
    setInterval(() => { maintainRolling().catch(e => console.error('[TopsellersDB]', e.message)); }, 10 * 60 * 1000);
}, 3 * 60 * 1000);

// Zazeni warmup TAKOJ po startu (3s zaradi express init) + vsakih 90s
setTimeout(() => {
    warmupPackingCache().catch(e => console.error('[Packing/Warmup] First run error:', e.message));
    setInterval(() => {
        warmupPackingCache().catch(e => console.error('[Packing/Warmup] Run error:', e.message));
    }, 90 * 1000);  // 5min -> 90s: bolj svez cache, manjsa luknja ob outage-u
}, 3 * 1000);  // 10s -> 3s: hitrejsi cold-start cache fill
// =====================================================

// [FAZA3] Globalni Express error handler: napaka v handlerju vrne cist 500 JSON
// (prej: obvisel zahtevek ali padec), vse pa se zabelezi za watchdog.
app.use((err, req, res, next) => {
    console.error('[HTTP-ERR]', req.method, req.path, (err && err.stack) || err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Internal error' });
});

app.listen(PORT, () => {
    console.log(`🚀 Launches server running on port ${PORT}`);
});
