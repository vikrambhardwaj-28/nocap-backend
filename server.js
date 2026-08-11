require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const cheerio = require('cheerio');
const axios = require('axios');
const puppeteer = require('puppeteer');
const Groq = require('groq-sdk');
const { extractAudio, transcribeAudio } = require('./audioService');

const app = express();

// Middlewares
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 50 * 1024 * 1024 }
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// -------------------------------------------------------------
// HELPER FUNCTIONS
// -------------------------------------------------------------

// Helper to safely cleanup files
function safeUnlink(filePath) {
    if (filePath && fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
        } catch (e) {
            console.error(`Failed to delete temp file ${filePath}:`, e.message);
        }
    }
}

// Download Audio using yt-dlp
function downloadAudioFromUrl(url, outputAudioPath) {
    return new Promise((resolve, reject) => {
        const args = ['-x', '--audio-format', 'mp3', '-o', outputAudioPath, url];
        execFile('yt-dlp', args, (error, stdout, stderr) => {
            if (error) return reject(error);
            resolve(outputAudioPath);
        });
    });
}

// Multi-stage Content Extractor for Title, Description & Page Text
async function extractContentFromUrl(url) {
    console.log("Extracting title/metadata for URL:", url);

    // Stage 1: Axios Fast Metadata Scrape
    try {
        console.log("Stage 1: Axios OpenGraph Scrape...");
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 7000
        });

        const $ = cheerio.load(response.data);
        const ogTitle = $('meta[property="og:title"]').attr('content') || $('title').text() || '';
        const ogDesc = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
        const bodyText = $('p').text().slice(0, 1500) || '';

        const combinedText = `Title: ${ogTitle}\nDescription: ${ogDesc}\nPage Text: ${bodyText}`.trim();
        if (combinedText.length > 30) {
            console.log("Stage 1 Success! Metadata extracted.");
            return combinedText;
        }
    } catch (e) {
        console.log("Stage 1 Failed (Axios blocked/timeout):", e.message);
    }

    // Stage 2: Puppeteer Headless Backup
    let browser = null;
    try {
        console.log("Stage 2: Puppeteer Browser Launch...");
        browser = await puppeteer.launch({ 
            headless: 'new',
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process'
            ]
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
        await new Promise(r => setTimeout(r, 1000));

        const extractedText = await page.evaluate(() => {
            const ogTitle = document.querySelector('meta[property="og:title"]')?.content || document.title || '';
            const ogDesc = document.querySelector('meta[property="og:description"]')?.content || document.querySelector('meta[name="description"]')?.content || '';
            const body = document.body?.innerText || '';
            return `Title: ${ogTitle}\nDescription: ${ogDesc}\nPage Text: ${body}`.slice(0, 2500);
        });

        await browser.close();
        if (extractedText.trim().length > 30) {
            console.log("Stage 2 Success via Puppeteer.");
            return extractedText.trim();
        }
    } catch (err) {
        console.error("Stage 2 Puppeteer Error:", err.message);
        if (browser) await browser.close();
    }

    return null;
}

// -------------------------------------------------------------
// 1. TEXT, LINK & ARTICLE FACT-CHECK ENDPOINT
// -------------------------------------------------------------
app.post('/api/check-text', async (req, res) => {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
        return res.status(400).json({ error: 'Valid text or claim input is required.' });
    }

    const trimmedInput = text.trim();
    const isUrl = /^https?:\/\//i.test(trimmedInput);
    let transcript = trimmedInput;
    let tempAudioPath = null;

    if (isUrl) {
        const audioFilename = `link_${Date.now()}.mp3`;
        tempAudioPath = path.join('uploads', audioFilename);

        try {
            console.log("Processing URL input:", trimmedInput);

            // 1. Extract Video/Page Title and Metadata
            const pageMeta = await extractContentFromUrl(trimmedInput) || '';

            // 2. Extract Spoken Audio Transcript using yt-dlp
            let audioTranscript = '';
            try {
                console.log("Downloading audio with yt-dlp...");
                await downloadAudioFromUrl(trimmedInput, tempAudioPath);
                audioTranscript = await transcribeAudio(tempAudioPath);
                console.log("Audio transcribed successfully.");
            } catch (audioErr) {
                console.log("Audio extraction failed or no audio track present:", audioErr.message);
            }

            // 3. Combine Both (Title + Description + Audio Transcript)
            if (audioTranscript && audioTranscript.trim().length > 0) {
                transcript = `Video Context (Title & Description):\n${pageMeta}\n\nSpoken Audio Transcript:\n${audioTranscript}`;
            } else if (pageMeta && pageMeta.trim().length > 25) {
                transcript = `Video Context (Title & Description):\n${pageMeta}`;
            } else {
                return res.status(400).json({ 
                    error: 'Unable to extract content from link. Please copy-paste the claim text directly!' 
                });
            }

        } catch (err) {
            console.error("URL Processing Error:", err);
            return res.status(400).json({ 
                error: 'Unable to process link automatically. Please copy-paste the claim text directly!' 
            });
        } finally {
            safeUnlink(tempAudioPath);
        }
    }

    // Groq Fact Checking Analysis
    try {
        console.log("Analyzing claim with Groq LLM...");
        const completion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: `You are markiv.site, an elite viral fact-checker. Respond ONLY with valid JSON.
                    
RATING RUBRIC:
- 9 to 10 (NO CAP): 100% Factually verified, scientifically sound.
- 5 to 8 (PARTIAL CAP): Exaggerated, clickbait, or key context missing.
- 1 to 4 (TOTAL CAP): Fake news, debunked myth, or blatantly false.`
                },
                {
                    role: "user",
                    content: `Analyze this content/claim:
"${transcript}"

Return strict JSON schema:
{
  "rating": number (1 to 10),
  "verdict": "NO CAP 🧢" | "PARTIAL CAP 🧢🧢" | "TOTAL CAP 🧢🧢🧢",
  "factCheck": "Direct factual assessment of the core claims made",
  "theCatch": "Missing context, exaggerated claims, or hidden details",
  "tldr": "Exactly 2 sentences summarizing reality"
}`
                }
            ],
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
            temperature: 0.2
        });

        const jsonResult = JSON.parse(completion.choices[0].message.content);
        res.json({ ...jsonResult, transcript: isUrl ? transcript : undefined });

    } catch (err) {
        console.error("GROQ ERROR:", err);
        res.status(500).json({ error: err.message || 'AI analysis failed.' });
    }
});

// -------------------------------------------------------------
// 2. VIDEO FILE UPLOAD ENDPOINT
// -------------------------------------------------------------
app.post('/api/check-video', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No video file provided.' });
    }

    const videoPath = req.file.path;
    const audioPath = path.join('uploads', `${req.file.filename}.mp3`);

    try {
        await extractAudio(videoPath, audioPath);
        const transcript = await transcribeAudio(audioPath);

        safeUnlink(videoPath);
        safeUnlink(audioPath);

        if (!transcript || transcript.trim().length === 0) {
            return res.status(400).json({ error: 'No clear speech detected in video audio.' });
        }

        const completion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: `You are markiv.site, a viral fact-checker. Respond ONLY with valid JSON.`
                },
                {
                    role: "user",
                    content: `Analyze this transcript: "${transcript}"
                    
                    Return strict JSON:
                    {
                      "rating": number (1 to 10),
                      "verdict": "NO CAP 🧢" | "PARTIAL CAP 🧢🧢" | "TOTAL CAP 🧢🧢🧢",
                      "factCheck": "Direct factual assessment",
                      "theCatch": "Missing context or exaggerated claims",
                      "tldr": "Exactly 2 sentences summarizing reality"
                    }`
                }
            ],
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
            temperature: 0.2
        });

        const jsonResult = JSON.parse(completion.choices[0].message.content);
        res.json({ ...jsonResult, transcript });

    } catch (err) {
        safeUnlink(videoPath);
        safeUnlink(audioPath);
        res.status(500).json({ error: err.message || 'Video processing failed.' });
    }
});

// -------------------------------------------------------------
// 3. AI CHATBOT ASSISTANT ENDPOINT
// -------------------------------------------------------------
app.post('/api/chat-assistant', async (req, res) => {
    const { message, mode } = req.body;
    
    if (!message || typeof message !== 'string') {
        return res.status(400).json({ reply: "Please type a valid message." });
    }

    let systemInstruction = "You are the markiv.site AI Assistant. Keep answers concise, helpful, and focused on assisting users with verifying viral claims, links, and videos on markiv.site.";
    if (mode === 'general') {
        systemInstruction = "You are a versatile, friendly AI assistant. Answer the user query accurately and concisely.";
    }

    try {
        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: systemInstruction },
                { role: "user", content: message }
            ],
            model: "llama-3.3-70b-versatile",
            temperature: 0.5,
            max_tokens: 250
        });

        const reply = completion.choices[0].message.content;
        res.json({ reply });
    } catch (err) {
        console.error("CHAT ASSISTANT ERROR:", err);
        res.status(500).json({ reply: "Sorry, I am having trouble processing your request right now." });
    }
});

// Health check endpoint for Cron-Job.org
app.get('/health', (req, res) => {
    res.status(200).send('Server is active');
});

// Start Server
const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`markiv.site Server running on port ${PORT}`);
});