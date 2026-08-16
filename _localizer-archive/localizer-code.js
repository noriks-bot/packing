// ============================================================================
// VIDEO-LOCALIZER — IZLOCEN iz packing/server.js dne 2026-08-16 (Dejan: "ne spada sem").
// Arhiv kode za morebitno kasnejso ozivitev kot samostojen servis. Podatki ostajajo:
// data/localizer-jobs.json, queue.json, uploads/ (preseljeni v ta arhiv).
// Za ozivitev: express skeleton + ta koda + multer + .env AI kljuci + ffmpeg.
// ============================================================================

// Video upload endpoint
app.post('/api/upload-video', upload.single('video'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No video file uploaded' });
    }
    
    console.log('Video uploaded:', req.file.filename, 'Size:', (req.file.size / 1024 / 1024).toFixed(2), 'MB');
    
    res.json({
        success: true,
        filename: req.file.filename,
        path: req.file.path,
        size: req.file.size
    });
});

// List uploaded videos
app.get('/api/videos', (req, res) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
        return res.json([]);
    }
    const files = fs.readdirSync(uploadDir).filter(f => f.startsWith('video-'));
    res.json(files.map(f => {
        const stat = fs.statSync(path.join(uploadDir, f));
        return {
            filename: f,
            size: stat.size,
            uploaded: stat.mtime
        };
    }).sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded)));
});

// Serve uploaded videos
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Gemini/OpenAI video analysis
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

app.post('/api/analyze-video', async (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'Missing filename' });
    
    const videoPath = path.join(__dirname, 'uploads', filename);
    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video not found' });
    
    try {
        // Extract frames from video (1 per second for first 30 seconds)
        const framesDir = path.join(__dirname, 'uploads', 'frames-' + Date.now());
        fs.mkdirSync(framesDir, { recursive: true });
        
        await execPromise(`nice -n 15 ffmpeg -i "${videoPath}" -vf "fps=1" -t 30 -q:v 2 "${framesDir}/frame-%03d.jpg" 2>/dev/null`);
        
        const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
        console.log(`Extracted ${frames.length} frames from ${filename}`);
        
        if (frames.length === 0) {
            fs.rmSync(framesDir, { recursive: true });
            return res.json({ texts: [], message: 'No frames extracted' });
        }
        
        // Analyze ALL frames - no sampling to ensure we catch every text
        const sampled = frames.slice(0, 30); // Analyze up to 30 frames (first 30 seconds)
        const extractedTexts = [];
        
        for (let i = 0; i < sampled.length; i++) {
            const framePath = path.join(framesDir, sampled[i]);
            const base64 = fs.readFileSync(framePath).toString('base64');
            const timestamp = `${Math.floor(i * 3)}s`;
            
            try {
                const response = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${OPENAI_API_KEY}`
                    },
                    body: JSON.stringify({
                        model: 'gpt-4o-mini',
                        messages: [{
                            role: 'user',
                            content: [
                                {
                                    type: 'text',
                                    text: 'Extract ALL visible text overlays from this video frame. Focus on marketing text, titles, subtitles, captions, call-to-actions. Return ONLY a JSON array of objects with "text" and "context" fields. Context should briefly describe where/what the text is (e.g., "headline", "subtitle", "CTA button"). If no text visible, return empty array [].'
                                },
                                {
                                    type: 'image_url',
                                    image_url: { url: `data:image/jpeg;base64,${base64}` }
                                }
                            ]
                        }],
                        max_tokens: 500
                    })
                });
                
                const data = await response.json();
                const content = data.choices?.[0]?.message?.content || '[]';
                
                // Parse JSON from response
                const jsonMatch = content.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    const texts = JSON.parse(jsonMatch[0]);
                    texts.forEach(t => {
                        // Avoid duplicates
                        if (!extractedTexts.find(e => e.text === t.text)) {
                            extractedTexts.push({ ...t, timestamp });
                        }
                    });
                }
            } catch (e) {
                console.error('Frame analysis error:', e.message);
            }
        }
        
        // Cleanup frames
        fs.rmSync(framesDir, { recursive: true });
        
        console.log(`Extracted ${extractedTexts.length} unique texts from ${filename}`);
        res.json({ texts: extractedTexts });
        
    } catch (e) {
        console.error('Video analysis error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Translate texts to multiple languages
app.post('/api/translate-texts', async (req, res) => {
    const { texts, languages } = req.body;
    if (!texts || !languages) return res.status(400).json({ error: 'Missing texts or languages' });
    
    const LANG_NAMES = {
        'HR': 'Croatian',
        'CZ': 'Czech', 
        'PL': 'Polish',
        'GR': 'Greek',
        'IT': 'Italian',
        'HU': 'Hungarian',
        'SK': 'Slovak'
    };
    
    try {
        const translations = [];
        
        // Batch all texts for translation
        const textsToTranslate = texts.map(t => t.text);
        
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [{
                    role: 'system',
                    content: `You are a professional marketing translator. Translate the given texts into the requested languages. Keep the tone punchy and marketing-appropriate. Maintain any emojis. Return ONLY valid JSON.`
                }, {
                    role: 'user',
                    content: `Translate these marketing texts into ${languages.map(l => LANG_NAMES[l]).join(', ')}:

${textsToTranslate.map((t, i) => `${i + 1}. "${t}"`).join('\n')}

Return as JSON array where each element has the language codes as keys:
[{"HR": "...", "CZ": "...", "PL": "...", "GR": "...", "IT": "...", "HU": "...", "SK": "..."}, ...]`
                }],
                max_tokens: 2000
            })
        });
        
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '[]';
        
        // Parse JSON from response
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            res.json({ translations: parsed });
        } else {
            res.json({ translations: [], error: 'Could not parse translations' });
        }
        
    } catch (e) {
        console.error('Translation error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============================================
// VIDEO LOCALIZER API
// ============================================

const localizationJobs = new Map();
const archiver = require('archiver');

// Start localization job
app.post('/api/localize', async (req, res) => {
    const { videoWithText, videoClean, name } = req.body;
    if (!videoWithText || !videoClean) {
        return res.status(400).json({ error: 'Missing videos' });
    }
    
    const jobId = `job-${Date.now()}`;
    const job = {
        id: jobId,
        name: name || jobId,
        videoWithText,
        videoClean,
        status: 'analyzing',
        progress: 0,
        completed: 0,
        created: new Date().toISOString(),
        outputs: {}
    };
    
    localizationJobs.set(jobId, job);
    
    // Start async processing
    processLocalizationJob(job).catch(e => {
        job.status = 'error';
        job.error = e.message;
        console.error('Localization error:', e);
    });
    
    res.json(job);
});

// List all jobs (must be before :id route)
app.get('/api/localize/list', (req, res) => {
    const jobs = Array.from(localizationJobs.values())
        .sort((a, b) => new Date(b.created) - new Date(a.created))
        .slice(0, 50);
    res.json(jobs);
});

// Get job status
app.get('/api/localize/:id', (req, res) => {
    const job = localizationJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

// Download individual video
app.get('/api/localize/:id/video/:lang', (req, res) => {
    const job = localizationJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    const videoPath = job.outputs[req.params.lang];
    if (!videoPath || !fs.existsSync(videoPath)) {
        return res.status(404).json({ error: 'Video not found' });
    }
    
    res.download(videoPath);
});

// Download all as ZIP
app.get('/api/localize/:id/download', (req, res) => {
    const job = localizationJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'done') return res.status(400).json({ error: 'Job not complete' });
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${job.name}-localized.zip"`);
    
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);
    
    for (const [lang, videoPath] of Object.entries(job.outputs)) {
        if (fs.existsSync(videoPath)) {
            archive.file(videoPath, { name: `${job.name}-${lang}.mp4` });
        }
    }
    
    archive.finalize();
});

// Process localization job
async function processLocalizationJob(job) {
    const LANGUAGES = ['HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK'];
    const outputDir = path.join(__dirname, 'uploads', 'localized', job.id);
    fs.mkdirSync(outputDir, { recursive: true });
    
    const videoWithTextPath = path.join(__dirname, 'uploads', job.videoWithText);
    const videoCleanPath = path.join(__dirname, 'uploads', job.videoClean);
    
    // Step 1: Analyze video with text
    job.status = 'analyzing';
    console.log(`[${job.id}] Analyzing video...`);
    
    const framesDir = path.join(outputDir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });
    
    // Extract frames
    await execPromise(`nice -n 15 ffmpeg -y -i "${videoWithTextPath}" -vf "fps=2" -t 30 -q:v 2 "${framesDir}/frame-%03d.jpg" 2>/dev/null`);
    
    const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
    const segments = [];
    let lastTexts = [];
    
    // Analyze frames with OpenAI Vision
    for (let i = 0; i < frames.length; i += 3) {
        const framePath = path.join(framesDir, frames[i]);
        const base64 = fs.readFileSync(framePath).toString('base64');
        const timestamp = (parseInt(frames[i].match(/\d+/)[0]) - 1) * 0.5;
        
        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [{ role: 'user', content: [
                        { type: 'text', text: 'Extract ALL visible text overlays from this video frame. Return JSON array: [{"text": "...", "position": "top/center/bottom"}]. If no text, return [].' },
                        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
                    ]}],
                    max_tokens: 300
                })
            });
            
            const data = await response.json();
            const content = data.choices?.[0]?.message?.content || '[]';
            const match = content.match(/\[[\s\S]*\]/);
            
            if (match) {
                try {
                    // Clean up common JSON issues from AI responses
                    let jsonStr = match[0]
                        .replace(/[\u201C\u201D]/g, '"')  // Smart quotes
                        .replace(/[\u2018\u2019]/g, "'")  // Smart apostrophes
                        .replace(/,\s*]/g, ']')          // Trailing commas
                        .replace(/,\s*}/g, '}');         // Trailing commas in objects
                    
                    const texts = JSON.parse(jsonStr);
                    texts.forEach(t => {
                        if (!t.text) return; // Skip empty texts
                        const existing = segments.find(s => s.text === t.text);
                        if (existing) {
                            existing.end = timestamp + 1;
                        } else if (!lastTexts.includes(t.text)) {
                            segments.push({ text: t.text, start: timestamp, end: timestamp + 1.5, position: t.position || 'center' });
                        }
                    });
                    lastTexts = texts.map(t => t.text).filter(Boolean);
                } catch (parseErr) {
                    console.error('JSON parse error:', parseErr.message, 'Content:', match[0].substring(0, 200));
                }
            }
        } catch (e) {
            console.error('Frame analysis error:', e.message);
        }
    }
    
    // Cleanup frames
    fs.rmSync(framesDir, { recursive: true });
    
    if (segments.length === 0) {
        throw new Error('No text found in video');
    }
    
    console.log(`[${job.id}] Found ${segments.length} text segments`);
    
    // Step 2: Translate
    job.status = 'translating';
    console.log(`[${job.id}] Translating...`);
    
    const textsToTranslate = segments.map(s => s.text);
    const transResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{
                role: 'system',
                content: 'You are a marketing translator for NORIKS men\'s underwear. Keep texts punchy and short.'
            }, {
                role: 'user',
                content: `Translate to Croatian, Czech, Polish, Greek, Italian, Hungarian, Slovak:\n\n${textsToTranslate.map((t, i) => `${i+1}. "${t}"`).join('\n')}\n\nReturn JSON: [{"HR":"...","CZ":"...","PL":"...","GR":"...","IT":"...","HU":"...","SK":"..."}, ...]`
            }],
            max_tokens: 2000
        })
    });
    
    const transData = await transResponse.json();
    const transContent = transData.choices?.[0]?.message?.content || '[]';
    const transMatch = transContent.match(/\[[\s\S]*\]/);
    const translations = transMatch ? JSON.parse(transMatch[0]) : [];
    
    // Step 3: Generate videos
    job.status = 'generating';
    console.log(`[${job.id}] Generating videos...`);
    
    for (let langIdx = 0; langIdx < LANGUAGES.length; langIdx++) {
        const lang = LANGUAGES[langIdx];
        
        // Create ASS file
        let ass = `[Script Info]\nTitle: ${job.name} ${lang}\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n`;
        ass += `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n`;
        ass += `Style: Default,Arial,64,&H00000000,&H000000FF,&H00000000,&H00FFFFFF,1,0,0,0,100,100,0,0,3,0,0,5,50,50,50,1\n\n`;
        ass += `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
        
        segments.forEach((seg, i) => {
            const text = translations[i]?.[lang] || seg.text;
            const start = formatAssTime(seg.start);
            const end = formatAssTime(seg.end);
            
            // For center stacking (hkrati), use \pos for precise control
            if (seg.position === 'center-top') {
                ass += `Dialogue: 0,${start},${end},Default,,0,0,0,,{\\an5\\pos(540,880)\\fad(200,200)}${text}\n`;
            } else if (seg.position === 'center-bottom') {
                ass += `Dialogue: 0,${start},${end},Default,,0,0,0,,{\\an5\\pos(540,1000)\\fad(200,200)}${text}\n`;
            } else {
                // Default center position
                ass += `Dialogue: 0,${start},${end},Default,,0,0,0,,{\\an5\\fad(200,200)}${text}\n`;
            }
        });
        
        const assPath = path.join(outputDir, `subs-${lang}.ass`);
        fs.writeFileSync(assPath, ass);
        
        // Generate video
        const outVideo = path.join(outputDir, `${job.name}-${lang}.mp4`);
        await execPromise(`nice -n 15 ffmpeg -y -i "${videoCleanPath}" -vf "ass='${assPath}':fontsdir=/usr/share/fonts" -c:a copy "${outVideo}" 2>/dev/null`);
        
        job.outputs[lang] = outVideo;
        job.completed = langIdx + 1;
        job.progress = Math.round(((langIdx + 1) / LANGUAGES.length) * 100);
        
        console.log(`[${job.id}] Generated ${lang} (${job.completed}/${LANGUAGES.length})`);
    }
    
    job.status = 'done';
    console.log(`[${job.id}] Complete!`);
}

function formatAssTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.floor((seconds % 1) * 100);
    return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}.${cs.toString().padStart(2,'0')}`;
}

// ============================================
// VIDEO LOCALIZER V2 API
// ============================================

// Persistent job storage
const JOBS_FILE = path.join(__dirname, 'data', 'localizer-jobs.json');

function loadJobs() {
    try {
        if (fs.existsSync(JOBS_FILE)) {
            return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading jobs:', e);
    }
    return [];
}

function saveJobs(jobs) {
    try {
        fs.mkdirSync(path.dirname(JOBS_FILE), { recursive: true });
        writeFileAtomic(JOBS_FILE, JSON.stringify(jobs, null, 2));
    } catch (e) {
        console.error('Error saving jobs:', e);
    }
}

// Load jobs from file into Map
const localizerJobs = new Map();
const savedJobs = loadJobs();
savedJobs.forEach(job => localizerJobs.set(job.id, job));
console.log(`Loaded ${savedJobs.length} localizer jobs from disk`);

// Helper to persist current jobs
function persistJobs() {
    const jobs = Array.from(localizerJobs.values());
    saveJobs(jobs);
}

const FFMPEG = '/usr/local/bin/ffmpeg';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// Smart video analysis - detect scene cuts using ffmpeg
app.post('/api/localizer/smart-analyze', async (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'Missing filename' });
    
    const videoPath = path.join(__dirname, 'uploads', filename);
    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video not found' });
    
    try {
        const jobId = `smart-${Date.now()}`;
        console.log(`[${jobId}] Starting scene detection for ${filename}`);
        
        // Get video duration
        const durationResult = await execPromise(`${FFMPEG} -i "${videoPath}" 2>&1 | grep Duration | cut -d ' ' -f 4 | sed s/,//`);
        const durationParts = durationResult.stdout.trim().split(':');
        const totalSeconds = parseInt(durationParts[0] || 0) * 3600 + parseInt(durationParts[1] || 0) * 60 + parseFloat(durationParts[2] || 0);
        
        console.log(`[${jobId}] Video duration: ${totalSeconds}s`);
        
        // Two-pass scene detection:
        // Pass 1: Low threshold (0.15) to catch all cuts including color changes
        // Pass 2: Merge segments that are too short (< 1s) with their neighbor
        const sceneCmd = `${FFMPEG} -i "${videoPath}" -vf "select='gt(scene,0.15)',showinfo" -f null - 2>&1 | grep showinfo | grep pts_time`;
        
        let sceneResult;
        try {
            sceneResult = await execPromise(sceneCmd);
        } catch (e) {
            sceneResult = { stdout: e.stdout || '', stderr: e.stderr || '' };
        }
        
        const output = sceneResult.stderr || sceneResult.stdout || '';
        
        // Parse ALL scene timestamps
        const rawSceneTimes = [0];
        const regex = /pts_time:([0-9.]+)/g;
        let match;
        while ((match = regex.exec(output)) !== null) {
            const time = parseFloat(match[1]);
            if (time - rawSceneTimes[rawSceneTimes.length - 1] >= 0.3) {
                rawSceneTimes.push(time);
            }
        }
        
        console.log(`[${jobId}] Raw scene cuts (${rawSceneTimes.length}):`, rawSceneTimes.map(t => t.toFixed(1)));
        
        // Create raw segments
        let segments = [];
        for (let i = 0; i < rawSceneTimes.length; i++) {
            const start = rawSceneTimes[i];
            const end = rawSceneTimes[i + 1] || totalSeconds;
            segments.push({ start, end, texts: [] });
        }
        
        // Merge segments shorter than 1.5s with their NEXT neighbor
        // (short segments are usually part of a transition, merge forward)
        const MIN_DURATION = 1.0;
        let merged = true;
        while (merged) {
            merged = false;
            for (let i = 0; i < segments.length; i++) {
                const dur = segments[i].end - segments[i].start;
                if (dur < MIN_DURATION && segments.length > 1) {
                    if (i < segments.length - 1) {
                        // Merge with next segment
                        segments[i + 1].start = segments[i].start;
                        segments.splice(i, 1);
                    } else {
                        // Last segment: merge with previous
                        segments[i - 1].end = segments[i].end;
                        segments.splice(i, 1);
                    }
                    merged = true;
                    break;
                }
            }
        }
        
        // Round timestamps
        segments = segments.map(s => ({
            start: Math.round(s.start * 10) / 10,
            end: Math.round(s.end * 10) / 10,
            texts: []
        }));
        
        console.log(`[${jobId}] Final segments (${segments.length}):`, segments.map(s => `${s.start}-${s.end}s`).join(', '));
        res.json({ segments, duration: totalSeconds });
        
    } catch (e) {
        console.error('Scene detection error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Translate texts to English for editing
app.post('/api/localizer/to-english', async (req, res) => {
    const { texts } = req.body;
    if (!texts?.length) return res.status(400).json({ error: 'Missing texts' });
    
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [{
                    role: 'system',
                    content: 'Translate marketing texts to English. Keep brand names unchanged. Keep translations short and punchy.'
                }, {
                    role: 'user',
                    content: `Translate these texts to English (or keep as-is if already English):

${texts.map((t, i) => `${i+1}. "${t}"`).join('\n')}

Return JSON array of translations in same order:
["translation1", "translation2", ...]`
                }],
                max_tokens: 1000
            })
        });
        
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '[]';
        const match = content.match(/\[[\s\S]*\]/);
        const translations = match ? JSON.parse(match[0]) : texts;
        
        res.json({ translations });
    } catch (e) {
        console.error('To-English error:', e);
        res.json({ translations: texts }); // Return original if translation fails
    }
});

// Translate to Slovenian (pivot language for localization)
app.post('/api/localizer/to-slovenian', async (req, res) => {
    const { texts } = req.body;
    if (!texts?.length) return res.status(400).json({ error: 'Missing texts' });
    
    console.log('To-Slovenian request:', texts.length, 'texts');
    console.log('Texts to translate:', texts);
    
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [{
                    role: 'system',
                    content: `Si profesionalni slovenski copywriter za NORIKS - premium moška spodnja oblačila (boksarice, majice).

PRAVILA:
1. NE prevajaj dobesedno - ustvari NARAVEN slovenski tekst ki ima SMISEL
2. Piši kot da govoriš s prijateljem - sproščeno, a prepričljivo
3. Kratko in udarno - max 5-7 besed če je mogoče
4. Če original ne pomeni nič dobesedno, razmisli kaj SPOROČILO želi povedati
5. Brand "NORIKS" ostane nespremenjen
6. Fokus: udobje, kvaliteta, mehkoba, premium občutek`
                }, {
                    role: 'user',
                    content: `Prevedi te marketinške tekste v naravno slovenščino. Jezik vira je lahko grščina, angleščina, madžarščina, poljščina, itd.

${texts.map((t, i) => `${i+1}. "${t}"`).join('\n')}

Vrni SAMO JSON array s slovenskimi prevodi:
["prevod1", "prevod2", ...]

POMEMBNO: Če tekst dobesedno preveden ne bi imel smisla, razmisli kaj želi povedati in napiši SMISELN slovenski tekst!`
                }],
                max_tokens: 1500
            })
        });
        
        const data = await response.json();
        console.log('OpenAI response:', JSON.stringify(data).substring(0, 500));
        
        const content = data.choices?.[0]?.message?.content || '[]';
        console.log('Translation content:', content);
        
        const match = content.match(/\[[\s\S]*\]/);
        const translations = match ? JSON.parse(match[0]) : texts;
        
        console.log('Parsed translations:', translations);
        
        res.json({ translations });
    } catch (e) {
        console.error('To-Slovenian error:', e);
        res.json({ translations: texts }); // Return original if translation fails
    }
});

// Analyze video - extract frames and scene descriptions
app.post('/api/localizer/analyze', async (req, res) => {
    const { filename, mode } = req.body;
    if (!filename) return res.status(400).json({ error: 'Missing filename' });
    
    const videoPath = path.join(__dirname, 'uploads', filename);
    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video not found' });
    
    try {
        const jobId = `analyze-${Date.now()}`;
        const framesDir = path.join(__dirname, 'uploads', 'analysis', jobId);
        fs.mkdirSync(framesDir, { recursive: true });
        
        // Extract frames at 2 fps for better timing accuracy and catching brief text
        console.log(`[${jobId}] Extracting frames from ${filename}...`);
        // Extract at 2fps to catch text that appears briefly
        await execPromise(`${FFMPEG} -y -i "${videoPath}" -vf "fps=2" -t 30 -q:v 1 "${framesDir}/frame-%03d.jpg" 2>/dev/null`);
        
        const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
        console.log(`[${jobId}] Extracted ${frames.length} frames`);
        
        if (frames.length === 0) {
            fs.rmSync(framesDir, { recursive: true });
            return res.json({ segments: [], texts: [] });
        }
        
        // Analyze frames with GPT-4o Vision - MORE SEGMENTS for dynamic text
        const segments = [];
        const texts = [];
        let lastDescription = '';
        
        // Analyze EVERY frame for more granular segments
        // At 2 fps: frame 1 = 0s, frame 2 = 0.5s, frame 3 = 1s, etc.
        // Analyze every frame (at 1fps this is reasonable - ~30 frames max)
        for (let i = 0; i < frames.length; i += 1) {
            const framePath = path.join(framesDir, frames[i]);
            const base64 = fs.readFileSync(framePath).toString('base64');
            const frameNum = parseInt(frames[i].match(/\d+/)[0]);
            const timestamp = (frameNum - 1) * 0.5; // 2 fps = 0.5s per frame
            
            try {
                const response = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
                    body: JSON.stringify({
                        model: 'gpt-4o',
                        messages: [{ role: 'user', content: [
                            { type: 'text', text: `Find ALL text overlays/captions in this video frame. This includes:
- Text with colored background boxes (white, orange, etc.)
- Text overlays WITHOUT background (floating text, subtitles)
- Large bold text added in post-production
- Call-to-action text, slogans, marketing phrases

Return JSON:
{
  "texts": [
    {"text": "exact text", "x": 50, "y": 30}
  ]
}

RULES:
- x,y = position as % of image (0-100)
- Include text in ANY language (Greek, Croatian, Czech, Polish, Hungarian, Italian, etc.)
- Multi-line text that belongs together = combine into one: "Line1 Line2"
- IGNORE: brand logos printed ON physical products/clothing, size labels on garments, watermarks
- INCLUDE: any text that was ADDED to the video in post-production (editing)

If no added text overlay visible, return: {"texts": []}` },
                            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
                        ]}],
                        max_tokens: 500
                    })
                });
                
                const data = await response.json();
                const content = data.choices?.[0]?.message?.content || '{}';
                
                // DEBUG: Log raw response for first 3 frames and any frames with text
                if (i < 3 || content.includes('"text"')) {
                    console.log(`[${jobId}] Frame ${i} (${timestamp}s) RAW:`, content.substring(0, 300));
                }
                
                // DEBUG: Log every frame's texts for troubleshooting
                console.log(`[${jobId}] Frame ${i} (${timestamp}s):`, content.match(/"text":\s*"[^"]+"/g)?.join(', ') || 'no texts');
                
                const match = content.match(/\{[\s\S]*\}/);
                
                if (match) {
                    // Clean up common JSON issues
                    let jsonStr = match[0]
                        .replace(/[\u201C\u201D]/g, '"')
                        .replace(/[\u2018\u2019]/g, "'")
                        .replace(/,\s*}/g, '}')
                        .replace(/,\s*]/g, ']');
                    
                    let parsed;
                    try {
                        parsed = JSON.parse(jsonStr);
                    } catch (parseErr) {
                        console.error('Analyze JSON parse error:', parseErr.message, 'Content:', jsonStr.substring(0, 200));
                        continue; // Skip this frame
                    }
                    
                    // Extract texts with timing (0.5s precision at 2fps)
                    const frameInterval = 0.5; // seconds per frame at 2fps
                    
                    if (parsed.texts?.length) {
                        parsed.texts.forEach(t => {
                            if (!t) return;
                            
                            // Handle both new format {text, x, y} and old format (string)
                            const isObject = typeof t === 'object';
                            const textContent = isObject ? t.text : t;
                            // Strip emojis and clean up text
                            const normalizedText = (textContent || '')
                                .replace(/[\u{1F300}-\u{1F9FF}]/gu, '') // Remove emojis
                                .replace(/[\u{2600}-\u{26FF}]/gu, '') // Remove misc symbols
                                .replace(/[\u{2700}-\u{27BF}]/gu, '') // Remove dingbats
                                .replace(/[\u{FE00}-\u{FE0F}]/gu, '') // Remove variation selectors
                                .replace(/[\u{1F000}-\u{1F02F}]/gu, '') // Remove mahjong
                                .replace(/[\u{1F0A0}-\u{1F0FF}]/gu, '') // Remove playing cards
                                .trim();
                            if (!normalizedText) return;
                            
                            // Get position data
                            const xPos = isObject ? (t.x || 50) : 50;
                            const yPos = isObject ? (t.y || 50) : 50;
                            const posLabel = isObject ? (t.position || 'center') : (parsed.textPosition || 'center');
                            
                            // Helper to strip emojis and normalize for comparison
                            const stripForCompare = (str) => str
                                .replace(/[\u{1F300}-\u{1F9FF}]/gu, '') // Remove emojis
                                .replace(/[^\p{L}\p{N}\s]/gu, '') // Keep only letters, numbers, spaces
                                .replace(/\s+/g, ' ')
                                .trim()
                                .toLowerCase();
                            
                            const normalizedForCompare = stripForCompare(normalizedText);
                            
                            // Check if this text (or very similar) already exists and is still open
                            const existingText = texts.find(x => !x.closed && (
                                x.text === normalizedText || 
                                x.text.toLowerCase() === normalizedText.toLowerCase() ||
                                stripForCompare(x.text) === normalizedForCompare
                            ));
                            
                            if (existingText) {
                                // Only extend if text was detected in consecutive frames (no gap)
                                const gap = timestamp - existingText.end;
                                if (gap <= frameInterval) {
                                    // Extend the end time of existing text
                                    existingText.end = timestamp + frameInterval;
                                    // Update position if we have better data
                                    if (isObject && t.x !== undefined) {
                                        existingText.x = xPos;
                                        existingText.y = yPos;
                                    }
                                } else {
                                    // Gap too large - this is a new appearance, add as new text
                                    console.log(`[gap] "${normalizedText}" reappeared after ${gap}s gap, adding as new`);
                                    texts.push({ 
                                        text: normalizedText, 
                                        start: timestamp,
                                        end: timestamp + frameInterval,
                                        position: posLabel,
                                        x: xPos,
                                        y: yPos
                                    });
                                }
                            } else {
                                // New text - add with start time and position
                                texts.push({ 
                                    text: normalizedText, 
                                    start: timestamp,
                                    end: timestamp + frameInterval,
                                    position: posLabel,
                                    x: xPos,
                                    y: yPos
                                });
                            }
                        });
                    }
                    
                    // Mark texts that are no longer visible in this frame
                    // Use normalized comparison (strip emojis/symbols)
                    const stripForCompare2 = (str) => (str || '')
                        .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
                        .replace(/[^\p{L}\p{N}\s]/gu, '')
                        .replace(/\s+/g, ' ')
                        .trim()
                        .toLowerCase();
                    
                    const currentTextsNormalized = (parsed.texts || []).map(t => {
                        const txt = typeof t === 'object' ? t.text : t;
                        return stripForCompare2(txt);
                    });
                    texts.forEach(t => {
                        if (!t.closed) {
                            const textNorm = stripForCompare2(t.text);
                            // STRICT comparison - only exact match counts as "still visible"
                            // This prevents "Navadne boksarice" staying open when "NORIKS boksarice" appears
                            const stillVisible = currentTextsNormalized.some(ct => ct === textNorm);
                            if (!stillVisible && timestamp > t.start) {
                                // Text disappeared - close it at this timestamp
                                t.end = timestamp;
                                t.duration = t.end - t.start;
                                t.closed = true;
                                console.log(`[closing] "${t.text}" ended at ${timestamp}s (was ${t.start}s-${t.end}s)`);
                            }
                        }
                    });
                    
                    // Create segment if new scene OR if current segment is too long (max 2 seconds for dynamic feel)
                    const currentSegmentTooLong = segments.length > 0 && (timestamp - segments[segments.length - 1].start) >= 2;
                    
                    if (parsed.isNewScene || segments.length === 0 || currentSegmentTooLong) {
                        // Close previous segment
                        if (segments.length > 0) {
                            segments[segments.length - 1].end = timestamp;
                        }
                        
                        segments.push({
                            id: segments.length,
                            start: timestamp,
                            end: timestamp + frameInterval,
                            description: parsed.description || `Scene ${segments.length + 1}`,
                            emotion: parsed.emotion || 'neutral',
                            thumbnail: `/launches/uploads/analysis/${jobId}/${frames[i]}`
                        });
                        
                        lastDescription = parsed.description || '';
                    } else {
                        // Extend current segment
                        if (segments.length > 0) {
                            segments[segments.length - 1].end = timestamp + frameInterval;
                        }
                    }
                }
            } catch (e) {
                console.error('Frame analysis error:', e.message);
            }
        }
        
        // Ensure last segment has proper end time (at 2fps, frame N = (N-1)*0.5 seconds)
        if (segments.length > 0 && frames.length > 0) {
            const lastFrame = parseInt(frames[frames.length - 1].match(/\d+/)[0]);
            const lastTimestamp = (lastFrame - 1) * 0.5 + 0.5; // End of last frame at 2fps
            segments[segments.length - 1].end = lastTimestamp;
        }
        
        // Close any still-open texts at the end
        texts.forEach(t => {
            if (!t.closed && frames.length > 0) {
                const lastFrame = parseInt(frames[frames.length - 1].match(/\d+/)[0]);
                t.end = (lastFrame - 1) * 0.5 + 0.5;
                t.duration = t.end - t.start;
            }
        });
        
        // Filter out brand names, size labels, and product text (not overlays)
        const BRAND_FILTER = ['noriks', 'nike', 'adidas', 'puma', 'under armour', 'calvin klein', 'tommy hilfiger', 'hugo boss', 'lacoste', 'ralph lauren', 'armani', 'diesel', 'levis', 'gap', 'zara', 'h&m', 'nano'];
        const SIZE_FILTER = ['xs', 's', 'm', 'l', 'xl', '2xl', '3xl', '4xl', '5xl', 'xxl', 'xxxl'];
        
        const filteredTexts = texts.filter(t => {
            const textLower = (t.text || '').toLowerCase().trim();
            // Remove if it's just a brand name
            if (BRAND_FILTER.some(brand => textLower === brand || textLower === brand.replace(' ', ''))) {
                return false;
            }
            // Remove size labels
            if (SIZE_FILTER.includes(textLower)) {
                return false;
            }
            // Remove brand + size combinations (e.g., "NORIKS 3XL", "NORIKS 2XL")
            if (/^noriks\s*\d*x*l$/i.test(textLower) || /^\d*x*l\s*noriks$/i.test(textLower)) {
                return false;
            }
            // Remove texts that are just brand names with sizes
            if (/^[a-z]+\s+(simple\s+)?(shirts|done|better)/i.test(textLower)) {
                return false; // "NORIKS Simple Shirts. Done Better"
            }
            // Remove very short texts (likely OCR errors or logos)
            if (textLower.length < 3) return false;
            // Remove if text spans almost entire video (likely logo on product)
            const duration = (t.end || 0) - (t.start || 0);
            const videoLength = frames.length * 0.5; // 2fps = 0.5s per frame
            if (duration > videoLength * 0.7) return false; // More than 70% of video = probably product logo
            return true;
        });
        
        console.log(`[${jobId}] Found ${segments.length} segments, ${texts.length} texts (${filteredTexts.length} after filtering)`);
        
        // POST-PROCESS: Merge overlapping/consecutive texts with same/similar content
        const mergedTexts = [];
        const normalizeForMerge = (str) => (str || '')
            .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
            .replace(/[^\p{L}\p{N}\s]/gu, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
        
        // Sort by start time
        filteredTexts.sort((a, b) => a.start - b.start);
        
        filteredTexts.forEach(t => {
            const tNorm = normalizeForMerge(t.text);
            // Find if there's an existing text with EXACTLY same content that overlaps or is consecutive
            const existing = mergedTexts.find(m => {
                const mNorm = normalizeForMerge(m.text);
                // STRICT: Only merge if texts are EXACTLY the same (normalized)
                if (mNorm !== tNorm) return false;
                
                // Check if overlapping OR consecutive (within 0.5s gap for 2fps)
                const overlaps = t.start <= m.end && t.end >= m.start;
                const gap = t.start - m.end;
                const isConsecutive = gap > 0 && gap <= 0.5;
                
                return overlaps || isConsecutive;
            });
            
            if (existing) {
                // Merge: extend time range to cover both
                existing.start = Math.min(existing.start, t.start);
                existing.end = Math.max(existing.end, t.end);
            } else {
                // Add new text
                mergedTexts.push({ ...t });
            }
        });
        
        console.log(`[${jobId}] After merging duplicates: ${mergedTexts.length} texts`);
        
        // DEBUG: Log each text with timing
        mergedTexts.forEach((t, i) => {
            console.log(`[${jobId}] Final text ${i}: "${t.text}" ${t.start}s-${t.end}s`);
        });
        
        // Use merged texts - return ORIGINAL language (no auto-translation)
        // User will click "Prevedi v SLO" button to translate separately
        const finalTexts = mergedTexts;
        
        console.log(`[${jobId}] ✅ Returning ${finalTexts.length} texts in original language`);
        
        res.json({ segments, texts: finalTexts, framesDir: jobId });
        
    } catch (e) {
        console.error('Analysis error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Generate 3 text variants per segment - MARKETING FOCUSED
app.post('/api/localizer/variants', async (req, res) => {
    const { segments, existingTexts, product, targetAudience } = req.body;
    if (!segments?.length) return res.status(400).json({ error: 'No segments provided' });
    
    // Detect product from video content
    const detectedProduct = product || 'tshirt'; // Default to tshirt
    
    // Product benefits database
    const productBenefits = {
        tshirt: [
            'Ne dviguje se nikoli',
            'Daljši kroj za popolno prileganje',
            'Velikosti do 4XL',
            'Na voljo v več barvah',
            'Premium udoben material',
            'Ostane na mestu tudi pri gibanju'
        ],
        boxers: [
            'Ne vrezujejo se',
            'Ne smrdijo cel dan',
            'Udobne od jutra do večera',
            'Premium material',
            'Popolnoma prileganje',
            'Brez neprijetnega dvigovanja'
        ]
    };
    
    // Hook templates by type
    const hookTemplates = {
        problem: [
            'Poznaš ta problem?',
            'Se ti tudi to dogaja?',
            'Zakaj vedno isto?',
            'A ti je tudi tega dovolj?',
            'Ta občutek poznaš...'
        ],
        solution: [
            'Končno rešitev!',
            'NORIKS to reši',
            'Obstaja boljši način',
            'Poglej razliko',
            'To je tisto kar rabiš'
        ],
        benefit: [
            'Udobje celo dan',
            'Samozavest v vsaki situaciji',
            'Brez skrbi',
            'Končno mir',
            'Občutek svobode'
        ],
        cta: [
            'Naroči zdaj',
            'Poglej več',
            'Link v opisu',
            'Klikni spodaj',
            'Ne zamudi'
        ]
    };
    
    try {
        const segmentDescriptions = segments.map((s, i) => 
            `${i+1}. [${s.start}s-${s.end}s] ${s.description} (emotion: ${s.emotion})`
        ).join('\n');
        
        const existingTextsList = existingTexts?.length 
            ? `\n\nOriginal texts from competitor video (ADAPT, don't copy!):\n${existingTexts.map(t => `- "${t.text}" at ${t.timestamp}s`).join('\n')}`
            : '';
        
        const benefits = productBenefits[detectedProduct] || productBenefits.tshirt;
        
        const numSegments = segments.length;
        
        // Determine story position for each segment
        const storyPositions = segments.map((seg, i) => {
            const position = i / (numSegments - 1 || 1);
            if (i === 0) return 'HOOK';
            if (i === numSegments - 1) return 'CTA';
            if (position < 0.3) return 'PROBLEM';
            if (position < 0.6) return 'REŠITEV';
            return 'BENEFIT';
        });
        
        const segmentDetails = segments.map((s, i) => 
            `Kader ${i+1} [${s.start}s-${s.end}s] - VLOGA: ${storyPositions[i]}
   Vizualno: ${s.description}
   Emocija: ${s.emotion}`
        ).join('\n\n');
        
        const prompt = `Si copywriter za NORIKS ${detectedProduct === 'tshirt' ? 'majice' : 'bokserice'}.

VIDEO ANALIZA - za vsak kader veš KAJ se dogaja in KAKŠNO VLOGO ima v zgodbi:

${segmentDetails}

PREDNOSTI PRODUKTA:
${benefits.map(b => `• ${b}`).join('\n')}

TVOJA NALOGA:
Za vsak kader napiši 3 ODLIČNE variante besedila.
Vsaka varianta mora:
1. UJEMATI vizualno vsebino (kar se vidi na kadru)
2. USTREZATI vlogi v zgodbi (HOOK/PROBLEM/REŠITEV/BENEFIT/CTA)
3. BITI kratka (max 5 besed) in prodajna

3 VARIANTE za vsak kader:
- A: Direkten pristop
- B: Vprašanje/dialog
- C: Čustveni pristop

PRIMERI po vlogah:
- HOOK: "Poznaš ta problem?" / "Ti je tega dovolj?" / "Poglej to..."
- PROBLEM: "Majica se dvigne..." / "Vedno ista zgodba" / "Trebuh na vidiku"
- REŠITEV: "NORIKS ostane na mestu" / "Končno rešitev" / "S NORIKS je drugače"
- BENEFIT: "Udobje cel dan" / "Velikosti do 4XL" / "Brez skrbi"
- CTA: "Naroči zdaj" / "Link v opisu" / "Klikni spodaj"

Vrni JSON array:
[{"segmentId": 0, "variants": {"A": "...", "B": "...", "C": "..."}}, ...]`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: 'Si expert copywriter za performance marketing. Pišeš kratke, udarne tekste ki prodajajo. Vedno odgovoriš SAMO z JSON formatom.' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 2000,
                temperature: 0.8
            })
        });
        
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '[]';
        const match = content.match(/\[[\s\S]*\]/);
        
        if (match) {
            const variants = JSON.parse(match[0]);
            
            // Merge variants into segments
            const result = segments.map((seg, i) => ({
                ...seg,
                variants: variants.find(v => v.segmentId === i)?.variants || {
                    A: hookTemplates.problem[i % hookTemplates.problem.length],
                    B: hookTemplates.solution[i % hookTemplates.solution.length],
                    C: hookTemplates.benefit[i % hookTemplates.benefit.length]
                }
            }));
            
            // Log generated variants
            console.log('=== GENERATED VARIANTS ===');
            result.forEach((seg, i) => {
                console.log(`Kader ${i+1} [${seg.start}s-${seg.end}s]: ${seg.description}`);
                console.log(`  A: ${seg.variants.A}`);
                console.log(`  B: ${seg.variants.B}`);
                console.log(`  C: ${seg.variants.C}`);
            });
            console.log('=== END VARIANTS ===');
            
            res.json({ segments: result });
        } else {
            res.status(500).json({ error: 'Failed to parse variants' });
        }
        
    } catch (e) {
        console.error('Variants error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ASS style definitions - Format: Name,Font,Size,Primary,Secondary,Outline,Back,Bold,Italic,Under,Strike,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Align,MarginL,R,V,Encoding
// BorderStyle: 1=outline+shadow, 3=opaque box
// Colors: &HAABBGGRR (hex, BGR order!)
// ============ PNG TEXT OVERLAY HELPERS ============
// Style configs for PNG generation: bgColor, textColor, cornerRadius multiplier
const pngStyleConfigs = {
    white:     { bg: 'white',              text: 'black', radius: 0.15 },
    black:     { bg: 'black',              text: 'white', radius: 0.15 },
    rounded:   { bg: 'white',              text: 'black', radius: 0.45 },
    shadow:    { bg: 'rgba(0,0,0,0.7)',    text: 'white', radius: 0.15 },
    gradient:  { bg: '#10b981',            text: 'white', radius: 0.15 },
    outline:   { bg: 'rgba(0,0,0,0.3)',    text: 'white', radius: 0.15, border: 'white' },
    red:       { bg: '#ef4444',            text: 'white', radius: 0.15 },
    orange:    { bg: '#f97316',            text: 'white', radius: 0.15 },
    yellow:    { bg: '#eab308',            text: 'black', radius: 0.15 },
    fire:      { bg: '#ff6600',            text: 'white', radius: 0.15 },
    neon:      { bg: 'black',              text: '#00ffff', radius: 0.15 },
    explosive: { bg: '#7c3aed',            text: 'white', radius: 0.15 },
    green:     { bg: '#22c55e',            text: 'white', radius: 0.15 },
    pulse:     { bg: '#10b981',            text: 'white', radius: 0.15 },
    urgent:    { bg: '#dc2626',            text: 'white', radius: 0.15 },
    gold:      { bg: '#fbbf24',            text: 'black', radius: 0.15 },
};

// Generates PNG images with box backgrounds using ImageMagick for ALL styles
async function generateTextOverlayPngs(texts, fontSize, outputDir, videoWidth = 1080, videoHeight = 1920) {
    const pngs = [];
    // Scale fontSize to match ASS rendering (ASS fontSize on PlayResY=1920 ≈ 65% of ImageMagick pointsize)
    const scaledFontSize = Math.round(fontSize * 0.65);
    const paddingX = Math.round(scaledFontSize * 0.6);
    const paddingY = Math.round(scaledFontSize * 0.35);
    
    for (let i = 0; i < texts.length; i++) {
        const t = texts[i];
        const styleName = t._resolvedStyle || t.style || 'white';
        const cfg = pngStyleConfigs[styleName] || pngStyleConfigs.white;
        const cornerRadius = Math.round(scaledFontSize * cfg.radius);
        
        // Escape text for shell
        const text = t.text.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/"/g, '\\\\"').replace(/`/g, '\\`');
        const pngPath = path.join(outputDir, `text-${i}.png`);
        
        // Max width: video width minus margins
        const maxTextWidth = videoWidth - paddingX * 2 - 40; // 40px safety margin
        
        // Step 1: Measure text with word wrap using caption: (auto-wraps to fit width)
        // First measure single line to check if wrapping needed
        const measureCmd = `convert -font "/usr/share/fonts/google-noto-vf/NotoSans[wght].ttf" -weight 700 -pointsize ${scaledFontSize} -gravity center label:"${text}" -format "%wx%h" info:`;
        let singleW = 9999, singleH = scaledFontSize;
        try {
            const { stdout } = await execPromise(measureCmd);
            const parts = stdout.trim().split('x');
            singleW = parseInt(parts[0]);
            singleH = parseInt(parts[1]);
        } catch (e) {}
        
        let imgW, imgH;
        let useCaption = singleW > maxTextWidth;
        
        if (useCaption) {
            // Text too wide - use caption: with fixed width for word wrapping
            const captionW = maxTextWidth;
            const measureWrapCmd = `convert -font "/usr/share/fonts/google-noto-vf/NotoSans[wght].ttf" -weight 700 -pointsize ${scaledFontSize} -size ${captionW}x -gravity center caption:"${text}" -format "%wx%h" info:`;
            try {
                const { stdout } = await execPromise(measureWrapCmd);
                const parts = stdout.trim().split('x');
                imgW = Math.round(parseInt(parts[0]) + paddingX * 2);
                imgH = Math.round(parseInt(parts[1]) + paddingY * 2);
            } catch (e) {
                imgW = captionW + paddingX * 2;
                imgH = Math.round(scaledFontSize * 2.6 + paddingY * 2);
            }
        } else {
            imgW = Math.round(singleW + paddingX * 2);
            imgH = Math.round(singleH + paddingY * 2);
        }
        
        // Step 2: Generate PNG with background rect + text
        let drawBg = `-fill "${cfg.bg}" -draw "roundrectangle 0,0 ${imgW-1},${imgH-1} ${cornerRadius},${cornerRadius}"`;
        if (cfg.border) {
            drawBg += ` -stroke "${cfg.border}" -strokewidth 3 -fill none -draw "roundrectangle 0,0 ${imgW-1},${imgH-1} ${cornerRadius},${cornerRadius}"`;
        }
        
        // Use caption: for wrapped text, label: for single line
        const textOp = useCaption 
            ? `-size ${imgW - paddingX * 2}x -gravity center caption:"${text}"`
            : `-gravity center -annotate +0+0 "${text}"`;
        
        const cmd = useCaption
            ? `convert \\( -size ${imgW}x${imgH} xc:"rgba(0,0,0,0)" ${drawBg} \\) \\( -font "/usr/share/fonts/google-noto-vf/NotoSans[wght].ttf" -weight 700 -pointsize ${scaledFontSize} -fill "${cfg.text}" -background none -size ${imgW - paddingX * 2}x -gravity center caption:"${text}" \\) -gravity center -composite PNG32:"${pngPath}"`
            : `convert -size ${imgW}x${imgH} xc:"rgba(0,0,0,0)" ${drawBg} -stroke none -fill "${cfg.text}" -font "/usr/share/fonts/google-noto-vf/NotoSans[wght].ttf" -weight 700 -pointsize ${scaledFontSize} -gravity center -annotate +0+0 "${text}" PNG32:"${pngPath}"`;
        await execPromise(cmd);
        
        // Calculate position (centered horizontally)
        const x = Math.round((videoWidth - imgW) / 2);
        const y = t._posY || Math.round(videoHeight / 2 - imgH / 2);
        
        pngs.push({ index: i, path: pngPath, x, y, w: imgW, h: imgH, start: t.start, end: t.end });
    }
    
    return pngs;
}

// ASS styles - Using BorderStyle=1 with large outline for continuous multi-line boxes
// Format: Name,Font,Size,Primary,Secondary,Outline,Back,Bold,Italic,Under,Strike,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Align,MarginL,R,V,Encoding
// ASS Styles with BorderStyle=3 (opaque box) for clean rectangular background
// Format: Name,Fontname,Fontsize,Primary,Secondary,Outline,Back,Bold,Italic,Underline,Strike,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Align,MarginL,MarginR,MarginV,Encoding
// BorderStyle=3 = opaque box, OutlineColour = box color, BackColour = box shadow
const assStyles = {
    // White box, black text (classic) - BorderStyle=3 for opaque box
    white: 'Style: Default,Noto Sans,72,&H00000000,&H000000FF,&H00FFFFFF,&H00FFFFFF,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Black box, white text  
    black: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // No box, just shadow
    shadow: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,0,5,5,50,50,200,1',
    // Smaller padding (looks rounder)
    rounded: 'Style: Default,Noto Sans,72,&H00000000,&H000000FF,&H00FFFFFF,&H00FFFFFF,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Green box (NORIKS brand)
    gradient: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H0081B910,&H0081B910,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // White outline, no fill
    outline: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,5,0,5,50,50,200,1',
    // === EXPLOSIVE STYLES FOR HOOK/CTA ===
    // Red box (#ef4444 = BGR: 4444EF)
    red: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H004444EF,&H004444EF,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Orange box (#f97316 = BGR: 1673F9)
    orange: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H001673F9,&H001673F9,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Yellow box (#eab308 = BGR: 08B3EA)
    yellow: 'Style: Default,Noto Sans,72,&H00000000,&H000000FF,&H0008B3EA,&H0008B3EA,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Fire - red/orange gradient effect (using red as base)
    fire: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H000066FF,&H000066FF,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Neon cyan on black (#0ff = BGR: FFFF00)
    neon: 'Style: Default,Noto Sans,72,&H00FFFF00,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Explosive - purple/red (#dc2626 = BGR: 2626DC, #7c3aed)
    explosive: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H00ED3A7C,&H00ED3A7C,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Green box (#22c55e = BGR: 5EC522)
    green: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H005EC522,&H005EC522,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Pulse - green gradient
    pulse: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H0081B910,&H0081B910,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Urgent - red with gold border (#dc2626 red, #fbbf24 gold)
    urgent: 'Style: Default,Noto Sans,72,&H00FFFFFF,&H000000FF,&H002626DC,&H002626DC,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1',
    // Gold (#fbbf24 = BGR: 24BFFB)
    gold: 'Style: Default,Noto Sans,72,&H00000000,&H000000FF,&H0024BFFB,&H0024BFFB,1,0,0,0,100,100,0,0,3,18,0,5,50,50,200,1'
};

// Generate Slovenian preview video
app.post('/api/localizer/preview', async (req, res) => {
    console.log('Preview request received:', req.body);
    const { videoClean, name, texts, language, style, fontSize = 72, hookStyle, ctaStyle } = req.body;
    if (!videoClean || !texts?.length) {
        console.log('Preview missing data:', { videoClean, textsLength: texts?.length });
        return res.status(400).json({ error: 'Missing data' });
    }
    
    const videoPath = path.join(__dirname, 'uploads', videoClean);
    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video not found' });
    
    try {
        const jobId = `preview-${Date.now()}`;
        const outputDir = path.join(__dirname, 'uploads', 'previews', jobId);
        fs.mkdirSync(outputDir, { recursive: true });
        
        console.log('Preview using style:', style, 'fontSize:', fontSize, 'hookStyle:', hookStyle, 'ctaStyle:', ctaStyle);
        console.log('[Preview] Per-text styles:', texts.map((t, i) => `[${i}] "${t.text?.substring(0,20)}" style=${t.style}`).join(', '));
        
        const baseStyle = assStyles[style] || assStyles.white;
        const defaultStyle = baseStyle.replace(/,Noto Sans,\d+,/, `,Noto Sans,${fontSize},`);
        
        // Create per-text styles
        const perTextStyleLines = [];
        const usedStyles = new Set();
        texts.forEach((t, i) => {
            const s = t.style || style;
            if (s !== style && !usedStyles.has(s)) {
                usedStyles.add(s);
                const base = assStyles[s] || assStyles.white;
                perTextStyleLines.push(base.replace('Style: Default,', `Style: S_${s},`).replace(/,Noto Sans,\d+,/, `,Noto Sans,${fontSize},`));
            }
        });
        
        // Hook/CTA styles
        if (hookStyle && !usedStyles.has(hookStyle)) {
            const base = assStyles[hookStyle] || assStyles.white;
            perTextStyleLines.push(base.replace('Style: Default,', 'Style: Hook,').replace(/,Noto Sans,\d+,/, `,Noto Sans,${fontSize},`));
        }
        if (ctaStyle && !usedStyles.has(ctaStyle)) {
            const base = assStyles[ctaStyle] || assStyles.white;
            perTextStyleLines.push(base.replace('Style: Default,', 'Style: CTA,').replace(/,Noto Sans,\d+,/, `,Noto Sans,${fontSize},`));
        }
        
        let ass = `[Script Info]
Title: ${name} Preview
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${defaultStyle}
${perTextStyleLines.join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
        
        // Separate rounded texts (PNG overlay) from others (ASS)
        const roundedTextIndices = [];
        texts.forEach((t, i) => {
            const resolvedStyle = t.style || style;
            if (resolvedStyle === 'rounded') {
                roundedTextIndices.push(i);
                return; // skip ASS for rounded
            }
            const start = formatAssTime(t.start);
            const end = formatAssTime(t.end);
            let styleName = (resolvedStyle !== style) ? `S_${resolvedStyle}` : 'Default';
            
            let pos = '\\an5\\pos(540,960)';
            if (t.position === 'center-top') pos = '\\an5\\pos(540,880)';
            else if (t.position === 'center-bottom') pos = '\\an5\\pos(540,1000)';
            else if (t.position === 'top') pos = '\\an8';
            else if (t.position === 'bottom') pos = '\\an2';
            
            ass += `Dialogue: 0,${start},${end},${styleName},,0,0,0,,{${pos}\\fad(200,200)}${t.text}\n`;
        });
        
        const assPath = path.join(outputDir, 'preview.ass');
        fs.writeFileSync(assPath, ass);
        
        // Generate PNG overlays for rounded texts
        const roundedOverlayTexts = roundedTextIndices.map(i => ({
            ...texts[i],
            _resolvedStyle: 'rounded',
            _posY: texts[i].position === 'center-top' ? 820 : texts[i].position === 'center-bottom' ? 1000 : 900
        }));
        const pngOverlays = await generateTextOverlayPngs(roundedOverlayTexts, fontSize, outputDir);
        
        const outputVideo = path.join(outputDir, `${name}-preview.mp4`);
        
        if (pngOverlays.length > 0) {
            // Combine ASS + PNG overlays
            const pngInputs = pngOverlays.map(p => `-i "${p.path}"`).join(' ');
            let fc = `[0:v]ass='${assPath}':fontsdir=/usr/share/fonts[assout]`;
            let lastLabel = '[assout]';
            pngOverlays.forEach((p, idx) => {
                const isLast = idx === pngOverlays.length - 1;
                const outLabel = isLast ? '[vout]' : `[ov${idx}]`;
                fc += `;${lastLabel}[${idx + 1}:v]overlay=${p.x}:${p.y}:enable='between(t\\,${p.start}\\,${p.end})'${outLabel}`;
                lastLabel = outLabel;
            });
            await execPromise(`${FFMPEG} -y -i "${videoPath}" ${pngInputs} -filter_complex "${fc}" -map "[vout]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a copy "${outputVideo}" 2>&1`);
        } else {
            await execPromise(`${FFMPEG} -y -i "${videoPath}" -vf "ass='${assPath}':fontsdir=/usr/share/fonts" -c:v libx264 -preset fast -crf 23 -c:a copy "${outputVideo}" 2>/dev/null`);
        }
        
        res.json({ 
            success: true, 
            videoUrl: `/launches/uploads/previews/${jobId}/${name}-preview.mp4` 
        });
        
    } catch (e) {
        console.error('Preview error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Generate all 7 country videos
app.post('/api/localizer/generate', async (req, res) => {
    console.log('Generate request:', JSON.stringify(req.body, null, 2));
    const { videoClean, name, texts, style, fontSize = 72, namingParts, hookStyle, ctaStyle, perTextStyles, countries, source, uppercase } = req.body;
    if (!videoClean || !texts?.length) {
        console.log('Generate 400: videoClean=', videoClean, 'texts=', texts);
        return res.status(400).json({ error: 'Missing data: videoClean=' + !!videoClean + ' texts=' + (texts?.length || 0) });
    }
    // Debug: log per-text styles
    if (perTextStyles) {
        console.log('[Generate] Per-text styles:', texts.map(t => `"${t.text?.substring(0,20)}" → style:${t.style}`).join(', '));
    }
    
    const videoPath = path.join(__dirname, 'uploads', videoClean);
    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video not found' });
    
    // Validate and default countries
    const ALL_COUNTRIES = ['HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK', 'DE'];
    const selectedCountries = (countries && Array.isArray(countries) && countries.length > 0) 
        ? countries.filter(c => ALL_COUNTRIES.includes(c))
        : ALL_COUNTRIES;
    
    const jobId = `gen-${Date.now()}`;
    const job = {
        id: jobId,
        name,
        namingParts, // { id, date, product, type, author }
        videoClean,
        texts,
        style: style || 'white',
        fontSize: fontSize || 72,
        hookStyle: hookStyle || null, // Style for hook_problem texts
        ctaStyle: ctaStyle || null,   // Style for cta texts
        perTextStyles: perTextStyles || false, // Enable per-text style overrides
        uppercase: uppercase || false, // All caps mode
        countries: selectedCountries, // Selected countries to generate
        source: source || 'library', // 'library' or 'localize'
        status: 'translating',
        completed: 0,
        currentLang: '',
        outputs: {},
        created: new Date().toISOString()
    };
    
    localizerJobs.set(jobId, job);
    persistJobs();
    
    // Start async generation
    generateAllCountries(job, videoPath).catch(e => {
        job.status = 'error';
        job.error = e.message;
        persistJobs();
        console.error(`[${jobId}] Error:`, e);
    });
    
    res.json({ jobId, status: 'started' });
});

// Quality Check Function - verifies texts and translation quality
async function qualityCheckVideo(videoPath, originalTexts, translations, langCode, langName, jobId) {
    const issues = [];
    const checks = [];
    
    try {
        // Extract frames at text timestamps for visual check
        const qcDir = path.join(path.dirname(videoPath), `qc-${langCode}`);
        fs.mkdirSync(qcDir, { recursive: true });
        
        // Get texts for this language
        const textsToCheck = originalTexts.slice(0, 3).map((t, i) => ({
            original: t.text,
            translated: translations[i]?.[langCode] || t.text,
            timestamp: t.start
        }));
        
        // Extract one frame per text (first 3 only for speed)
        for (let i = 0; i < textsToCheck.length; i++) {
            const t = textsToCheck[i];
            const framePath = path.join(qcDir, `frame-${i}.jpg`);
            await execPromise(`${FFMPEG} -y -ss ${t.timestamp + 0.5} -i "${videoPath}" -frames:v 1 -q:v 2 "${framePath}" 2>/dev/null`);
        }
        
        // Use GPT-4o to verify translation quality (batch check)
        const translatedTexts = textsToCheck.map(t => t.translated);
        
        const qcResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [{
                    role: 'system',
                    content: `You are a NATIVE ${langName} speaker reviewing marketing translations.
Your job is to check if texts sound NATURAL to a native speaker.

Rate each text:
- ✅ GOOD = sounds natural, a native would say it this way
- ⚠️ AWKWARD = understandable but sounds foreign/robotic
- ❌ BAD = confusing, wrong grammar, or doesn't make sense

Be STRICT - if a native speaker would find it odd, mark it as AWKWARD or BAD.`
                }, {
                    role: 'user',
                    content: `Review these ${langName} marketing texts for NORIKS men's clothing:

${translatedTexts.map((t, i) => `${i + 1}. "${t}"`).join('\n')}

Return JSON array with verdicts:
[
  {"text": "...", "verdict": "GOOD|AWKWARD|BAD", "suggestion": "better version if not GOOD", "reason": "brief explanation"}
]`
                }],
                max_tokens: 1000
            })
        });
        
        const qcData = await qcResponse.json();
        const qcContent = qcData.choices?.[0]?.message?.content || '[]';
        
        const qcMatch = qcContent.match(/\[[\s\S]*\]/);
        if (qcMatch) {
            try {
                const verdicts = JSON.parse(qcMatch[0]);
                verdicts.forEach((v, i) => {
                    checks.push({
                        text: translatedTexts[i],
                        verdict: v.verdict,
                        suggestion: v.suggestion,
                        reason: v.reason
                    });
                    
                    if (v.verdict !== 'GOOD') {
                        issues.push({
                            type: 'translation',
                            text: translatedTexts[i],
                            verdict: v.verdict,
                            suggestion: v.suggestion,
                            reason: v.reason
                        });
                    }
                });
            } catch (e) {
                console.error(`[${jobId}] QC JSON parse error:`, e.message);
            }
        }
        
        // Cleanup QC frames
        fs.rmSync(qcDir, { recursive: true, force: true });
        
    } catch (e) {
        console.error(`[${jobId}] QC error:`, e.message);
        issues.push({ type: 'error', message: e.message });
    }
    
    return { 
        lang: langCode, 
        langName,
        issues, 
        checks,
        passed: issues.length === 0 
    };
}

async function generateAllCountries(job, videoPath) {
    // Use job.countries if specified, otherwise default to all
    const LANGUAGES = job.countries || ['HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK', 'DE'];
    const LANG_NAMES = {
        HR: 'Croatian', CZ: 'Czech', PL: 'Polish', 
        GR: 'Greek', IT: 'Italian', HU: 'Hungarian', SK: 'Slovak'
    };
    
    const outputDir = path.join(__dirname, 'uploads', 'generated', job.id);
    fs.mkdirSync(outputDir, { recursive: true });
    
    // Step 1: Translate all texts
    console.log(`[${job.id}] Translating texts to ${LANGUAGES.length} languages: ${LANGUAGES.join(', ')}...`);
    
    // Build language list for translation prompt
    const langList = LANGUAGES.map(l => LANG_NAMES[l]).join(', ');
    const jsonFormat = LANGUAGES.map(l => `"${l}":"..."`).join(',');
    
    const textsToTranslate = job.texts.map(t => t.text);
    const transResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{
                role: 'system',
                content: `You are a professional marketing translator with NATIVE-SPEAKER fluency in ${langList}.

CRITICAL RULES:
1. Translate for NATURAL speech, NOT literal word-for-word
2. Use colloquial, everyday language that locals actually speak
3. Match the casual, punchy marketing tone
4. Keep texts SHORT and IMPACTFUL (max 5 words ideally)
5. Brand name "NORIKS" stays unchanged
6. Adapt idioms/expressions to what natives would say
7. Target: men buying for themselves OR women buying gifts for partners

Product: NORIKS premium men's clothing (t-shirts, boxers) - emphasize comfort, quality, fit.`
            }, {
                role: 'user',
                content: `Translate these Slovenian marketing texts. Make them sound like a NATIVE SPEAKER wrote them:

${textsToTranslate.map((t, i) => `${i+1}. "${t}"`).join('\n')}

Return ONLY valid JSON array:
[{${jsonFormat}}, ...]`
            }],
            max_tokens: 2000
        })
    });
    
    const transData = await transResponse.json();
    const transContent = transData.choices?.[0]?.message?.content || '[]';
    console.log(`[${job.id}] Raw translation response:`, transContent.substring(0, 500));
    
    const transMatch = transContent.match(/\[[\s\S]*\]/);
    let translations = [];
    try {
        translations = transMatch ? JSON.parse(transMatch[0]) : [];
    } catch (e) {
        console.error(`[${job.id}] Failed to parse translations:`, e.message);
    }
    
    console.log(`[${job.id}] Parsed ${translations.length} translation objects`);
    if (translations.length > 0) {
        console.log(`[${job.id}] First translation object:`, JSON.stringify(translations[0]));
    }
    
    // Check if cancelled during translation
    if (job.cancelled) {
        console.log(`[${job.id}] Job cancelled during translation`);
        job.status = 'cancelled';
        persistJobs();
        return;
    }
    
    console.log(`[${job.id}] Translations ready. Generating videos...`);
    
    // DEBUG: Log all texts with their timing
    console.log(`[${job.id}] Input texts (${job.texts.length}):`);
    job.texts.forEach((t, i) => {
        console.log(`[${job.id}]   ${i}: "${t.text}" @ ${t.start}s-${t.end}s pos(${t.x},${t.y})`);
    });
    
    job.status = 'generating';
    
    // Step 2: Generate video for each language
    for (let langIdx = 0; langIdx < LANGUAGES.length; langIdx++) {
        // Check if job was cancelled
        if (job.cancelled) {
            console.log(`[${job.id}] Job cancelled, stopping generation`);
            job.status = 'cancelled';
            job.currentLang = '';
            persistJobs();
            return;
        }
        
        const lang = LANGUAGES[langIdx];
        job.currentLang = lang;
        
        console.log(`[${job.id}] Generating ${lang}...`);
        
        // Get styles with custom font size
        const baseStyle = assStyles[job.style] || assStyles.white;
        const defaultStyle = baseStyle.replace(/,Noto Sans,\d+,/, `,Noto Sans,${job.fontSize || 72},`);
        
        // Create Hook and CTA styles if specified
        let hookStyleLine = '';
        let ctaStyleLine = '';
        
        if (job.hookStyle) {
            const hookBase = assStyles[job.hookStyle] || assStyles.white;
            hookStyleLine = hookBase
                .replace('Style: Default,', 'Style: Hook,')
                .replace(/,Noto Sans,\d+,/, `,Noto Sans,${job.fontSize || 72},`);
        }
        
        if (job.ctaStyle) {
            const ctaBase = assStyles[job.ctaStyle] || assStyles.white;
            ctaStyleLine = ctaBase
                .replace('Style: Default,', 'Style: CTA,')
                .replace(/,Noto Sans,\d+,/, `,Noto Sans,${job.fontSize || 72},`);
        }
        
        // Build styles - if perTextStyles, create style for each unique style used
        let additionalStyles = '';
        const usedStyles = new Set();
        
        if (job.perTextStyles) {
            job.texts.forEach(t => {
                if (t.style && t.style !== (job.style || 'white')) {
                    usedStyles.add(t.style);
                }
            });
            
            usedStyles.forEach(styleName => {
                const styleBase = assStyles[styleName] || assStyles.white;
                const styleFormatted = styleBase
                    .replace('Style: Default,', `Style: ${styleName},`)
                    .replace(/,Noto Sans,\d+,/, `,Noto Sans,${job.fontSize || 72},`);
                additionalStyles += styleFormatted + '\n';
            });
        }
        
        // Create ASS file
        let ass = `[Script Info]
Title: ${job.name} ${lang}
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${defaultStyle}
${hookStyleLine}
${ctaStyleLine}
${additionalStyles}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
        
        const roundedTextIndicesGen = [];
        job.texts.forEach((t, i) => {
            const translatedText = translations[i]?.[lang];
            let text = translatedText || t.text;
            if (job.uppercase) text = text.toUpperCase();
            
            if (i === 0) {
                console.log(`[${job.id}] Text 0 for ${lang}: translated="${translatedText}" original="${t.text}" using="${text}"`);
            }
            const start = formatAssTime(t.start);
            const end = formatAssTime(t.end);
            
            // Resolve style
            const resolvedStyle = (job.perTextStyles && t.style) ? t.style : (job.style || 'white');
            
            // Skip rounded - will be PNG overlay
            if (resolvedStyle === 'rounded') {
                roundedTextIndicesGen.push({ idx: i, text, start: t.start, end: t.end, y: t.y, position: t.position });
                return;
            }
            
            let styleName = 'Default';
            if (job.perTextStyles && t.style && t.style !== (job.style || 'white')) {
                styleName = t.style;
            } else if (t.role === 'hook_problem' && job.hookStyle) {
                styleName = 'Hook';
            } else if (t.role === 'cta' && job.ctaStyle) {
                styleName = 'CTA';
            }
            
            const pixelX = 540;
            const pixelY = (t.y !== undefined) ? Math.round((t.y / 100) * 1920) : 900;
            const posOverride = `\\an5\\pos(${pixelX},${pixelY})`;
            
            ass += `Dialogue: 0,${start},${end},${styleName},,0,0,0,,{${posOverride}\\fad(200,200)}${text}\n`;
        });
        
        const assPath = path.join(outputDir, `subs-${lang}.ass`);
        fs.writeFileSync(assPath, ass);
        
        // Generate PNG overlays for rounded texts
        const roundedGenTexts = roundedTextIndicesGen.map(rt => ({
            ...rt,
            _resolvedStyle: 'rounded',
            _posY: rt.position === 'center-top' ? 820 : rt.position === 'center-bottom' ? 1000 : (rt.y !== undefined ? Math.round((rt.y / 100) * 1920) - 60 : 900)
        }));
        const genPngOverlays = await generateTextOverlayPngs(roundedGenTexts, job.fontSize || 72, outputDir);
        
        // Generate video with naming convention
        let videoName;
        if (job.namingParts) {
            const { id, date, product, type, author } = job.namingParts;
            videoName = `${id}_${date}_${lang}_${product}_${type}_${author}`;
        } else {
            videoName = `${job.name}-${lang}`;
        }
        const outVideo = path.join(outputDir, `${videoName}.mp4`);
        
        if (genPngOverlays.length > 0) {
            const pngInputs = genPngOverlays.map(p => `-i "${p.path}"`).join(' ');
            let fc = `[0:v]ass='${assPath}':fontsdir=/usr/share/fonts[assout]`;
            let lastLabel = '[assout]';
            genPngOverlays.forEach((p, idx) => {
                const isLast = idx === genPngOverlays.length - 1;
                const outLabel = isLast ? '[vout]' : `[ov${idx}]`;
                fc += `;${lastLabel}[${idx + 1}:v]overlay=${p.x}:${p.y}:enable='between(t\\,${p.start}\\,${p.end})'${outLabel}`;
                lastLabel = outLabel;
            });
            await execPromise(`${FFMPEG} -y -i "${videoPath}" ${pngInputs} -filter_complex "${fc}" -map "[vout]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a copy "${outVideo}" 2>&1`);
        } else {
            await execPromise(`${FFMPEG} -y -i "${videoPath}" -vf "ass='${assPath}':fontsdir=/usr/share/fonts" -c:v libx264 -preset fast -crf 23 -c:a copy "${outVideo}" 2>/dev/null`);
        }
        
        job.outputs[lang] = outVideo;
        job.completed = langIdx + 1;
        
        // QUALITY CHECK: Verify texts and translations
        try {
            const qcResults = await qualityCheckVideo(outVideo, job.texts, translations, lang, LANG_NAMES[lang], job.id);
            if (!job.qualityChecks) job.qualityChecks = {};
            job.qualityChecks[lang] = qcResults;
            
            if (qcResults.issues.length > 0) {
                console.log(`[${job.id}] ⚠️ QC issues for ${lang}:`, qcResults.issues);
            } else {
                console.log(`[${job.id}] ✅ QC passed for ${lang}`);
            }
        } catch (qcErr) {
            console.error(`[${job.id}] QC error for ${lang}:`, qcErr.message);
        }
        
        persistJobs(); // Save progress
        
        console.log(`[${job.id}] ${lang} done (${job.completed}/${LANGUAGES.length})`);
    }
    
    job.status = 'done';
    job.currentLang = '';
    job.completedAt = new Date().toISOString();
    persistJobs(); // Save final state
    console.log(`[${job.id}] All done!`);
    
    // TODO: Send Telegram notification
}

// List all jobs
app.get('/api/localizer/jobs', (req, res) => {
    const jobs = Array.from(localizerJobs.values());
    res.json({ jobs });
});

// Get job status
app.get('/api/localizer/job/:id', (req, res) => {
    const job = localizerJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

// Download individual video
app.get('/api/localizer/job/:id/video/:lang', (req, res) => {
    const job = localizerJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    const videoPath = job.outputs[req.params.lang];
    if (!videoPath || !fs.existsSync(videoPath)) {
        return res.status(404).json({ error: 'Video not found' });
    }
    
    res.download(videoPath);
});

// Download all as ZIP
app.get('/api/localizer/job/:id/zip', (req, res) => {
    const job = localizerJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'done') return res.status(400).json({ error: 'Job not complete' });
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${job.name}-all-countries.zip"`);
    
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);
    
    for (const [lang, videoPath] of Object.entries(job.outputs)) {
        if (fs.existsSync(videoPath)) {
            archive.file(videoPath, { name: `${job.name}-${lang}.mp4` });
        }
    }
    
    archive.finalize();
});

// Delete a job (only if author matches)
app.delete('/api/localizer/job/:id', (req, res) => {
    const { author } = req.body; // Username of the person trying to delete
    const job = localizerJobs.get(req.params.id);
    
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    // Check if author matches (case insensitive)
    const jobAuthor = job.namingParts?.author?.toUpperCase() || '';
    const requestAuthor = (author || '').toUpperCase();
    
    if (jobAuthor && requestAuthor && jobAuthor !== requestAuthor) {
        return res.status(403).json({ error: 'Lahko brišeš samo svoje kreative' });
    }
    
    // Delete video files
    const outputDir = path.join(__dirname, 'uploads', 'generated', job.id);
    if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
        console.log(`Deleted video folder: ${outputDir}`);
    }
    
    // Remove from map and persist
    localizerJobs.delete(req.params.id);
    persistJobs();
    
    console.log(`Job ${req.params.id} deleted by ${author}`);
    res.json({ success: true });
});

// Cancel a generating job
app.post('/api/localizer/job/:id/cancel', (req, res) => {
    const job = localizerJobs.get(req.params.id);
    
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    if (job.status !== 'translating' && job.status !== 'generating') {
        return res.status(400).json({ error: 'Job is not in progress' });
    }
    
    job.cancelled = true;
    persistJobs();
    
    console.log(`Job ${req.params.id} cancelled`);
    res.json({ success: true, message: 'Job will be cancelled' });
});

// List all generated videos
app.get('/api/localizer/generated-videos', (req, res) => {
    try {
        const generatedDir = path.join(__dirname, 'uploads', 'generated');
        
        if (!fs.existsSync(generatedDir)) {
            return res.json({ jobs: [] });
        }
        
        const folders = fs.readdirSync(generatedDir)
            .filter(f => fs.statSync(path.join(generatedDir, f)).isDirectory())
            .sort((a, b) => {
                // Extract timestamp from folder name
                const tsA = a.match(/\d+/)?.[0] || '0';
                const tsB = b.match(/\d+/)?.[0] || '0';
                return parseInt(tsB) - parseInt(tsA); // Newest first
            });
        
        const jobs = folders.map(folder => {
            const folderPath = path.join(generatedDir, folder);
            const files = fs.readdirSync(folderPath);
            
            const videos = files.map(file => {
                const filePath = path.join(folderPath, file);
                const stats = fs.statSync(filePath);
                return {
                    name: file,
                    size: stats.size,
                    created: stats.mtime
                };
            });
            
            // Extract timestamp from folder name
            const tsMatch = folder.match(/(\d+)/);
            const timestamp = tsMatch ? tsMatch[1] : Date.now();
            
            return {
                id: folder,
                timestamp,
                videos
            };
        });
        
        res.json({ jobs });
        
    } catch (err) {
        console.error('Error listing generated videos:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============ NIGHT QUEUE ENDPOINTS ============

// Add job to queue
app.post('/api/queue/add', (req, res) => {
    const { mode, name, namingParts, videoClean, texts, style, fontSize, countries } = req.body;
    if (!name || !videoClean || !texts?.length) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Validate countries
    const ALL_COUNTRIES = ['HR', 'CZ', 'PL', 'GR', 'IT', 'HU', 'SK', 'DE'];
    const selectedCountries = (countries && Array.isArray(countries) && countries.length > 0) 
        ? countries.filter(c => ALL_COUNTRIES.includes(c))
        : ALL_COUNTRIES;
    
    const queue = loadQueue();
    const job = {
        id: `queue-${Date.now()}`,
        mode,
        name,
        namingParts, // { id, date, product, type, author }
        videoClean,
        texts,
        style: style || 'white',
        fontSize: fontSize || 72,
        countries: selectedCountries,
        status: 'pending',
        created: new Date().toISOString()
    };
    
    queue.push(job);
    saveQueue(queue);
    
    console.log(`[Queue] Added: ${name} (${texts.length} texts)`);
    res.json({ success: true, jobId: job.id });
});

// List queue
app.get('/api/queue/list', (req, res) => {
    const queue = loadQueue();
    res.json({ queue });
});

// Remove from queue
app.post('/api/queue/remove', (req, res) => {
    const { jobId } = req.body;
    let queue = loadQueue();
    queue = queue.filter(j => j.id !== jobId);
    saveQueue(queue);
    res.json({ success: true });
});

// Process queue now
app.post('/api/queue/process', async (req, res) => {
    const queue = loadQueue();
    const pending = queue.filter(j => j.status === 'pending');
    
    if (pending.length === 0) {
        return res.json({ message: 'Queue is empty', count: 0 });
    }
    
    res.json({ message: 'Processing started', count: pending.length });
    
    // Process in background
    processQueue();
});

// Background queue processor
async function processQueue() {
    const queue = loadQueue();
    
    for (const job of queue) {
        if (job.status !== 'pending') continue;
        
        console.log(`[Queue] Processing: ${job.name}`);
        job.status = 'processing';
        saveQueue(queue);
        
        try {
            const videoPath = path.join(__dirname, 'uploads', job.videoClean);
            if (!fs.existsSync(videoPath)) {
                throw new Error('Video not found');
            }
            
            // Create a generation job and process it
            const genJob = {
                id: job.id,
                name: job.name,
                namingParts: job.namingParts, // { id, date, product, type, author }
                videoClean: job.videoClean,
                texts: job.texts,
                style: job.style,
                fontSize: job.fontSize || 72,
                countries: job.countries, // Selected countries to generate
                status: 'translating',
                completed: 0,
                outputs: {},
                created: job.created
            };
            
            localizerJobs.set(job.id, genJob);
            await generateAllCountries(genJob, videoPath);
            
            job.status = 'done';
            job.completedAt = new Date().toISOString();
            console.log(`[Queue] Done: ${job.name}`);
        } catch (e) {
            console.error(`[Queue] Error processing ${job.name}:`, e);
            job.status = 'error';
            job.error = e.message;
        }
        
        saveQueue(queue);
    }
    
    console.log('[Queue] Processing complete');
}

// ============ END QUEUE ENDPOINTS ============

// ============ FINANCE API ============



// Configure multer for video uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const ext = path.extname(file.originalname);
        cb(null, `video-${timestamp}${ext}`);
    }
});
const upload = multer({ 
    storage,
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/')) cb(null, true);
        else cb(new Error('Only video files allowed'));
    }
});



const multer = require('multer');


const QUEUE_FILE = path.join(__dirname, 'queue.json');

// Queue persistence
function loadQueue() {
    try {
        if (fs.existsSync(QUEUE_FILE)) {
            return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
        }
    } catch (e) { console.error('Queue load error:', e); }
    return [];
}


function saveQueue(queue) {
    writeFileAtomic(QUEUE_FILE, JSON.stringify(queue, null, 2));
}
