require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const axios = require('axios');
const cheerio = require('cheerio');
const Groq = require('groq-sdk');
const { extractAudio, transcribeAudio } = require('./audioService');

const app = express();

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Multer configured with 100MB limit for video uploads
const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 100 * 1024 * 1024 }
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// CLOUDFLARE WORKER PROXY CONFIGURATION
const CLOUDFLARE_PROXY_URL = 'https://nocap-proxy.vikram-2872006.workers.dev?url=';

// RAPIDAPI KEY (Fallback if not in .env)
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'fe1ae17be4msh6598cb25386ba06p16a032jsnbf401f5e081a';

// -------------------------------------------------------------
// HELPER FUNCTIONS
// -------------------------------------------------------------

// 1. RapidAPI Extractor for Meta Links (Instagram / Facebook) -> Zero IP Block
async function fetchSocialMediaMetadata(url) {
    try {
        console.log("Fetching content via RapidAPI (Bypassing IP Block)...");
        const options = {
            method: 'GET',
            url: 'https://instagram-downloader-scraper-reels-igtv-posts-stories.p.rapidapi.com/scraper',
            params: { url: url },
            headers: {
                'x-rapidapi-key': RAPIDAPI_KEY,
                'x-rapidapi-host': 'instagram-downloader-scraper-reels-igtv-posts-stories.p.rapidapi.com',
                'Content-Type': 'application/json'
            },
            timeout: 12000
        };

        const response = await axios.request(options);
        const data = response.data;

        let textContent = "";
        if (typeof data === 'object') {
            textContent = data.caption || data.title || data.description || JSON.stringify(data);
        } else if (typeof data === 'string') {
            textContent = data;
        }

        return textContent.trim();
    } catch (err) {
        console.error("RapidAPI Extraction Error:", err.message);
        return null;
    }
}

// 2. Video Audio Downloader (yt-dlp for YouTube)
function downloadAudioFromUrl(url, outputAudioPath) {
    return new Promise((resolve, reject) => {
        const command = `yt-dlp --extractor-args "youtube:player_client=android,web" -x --audio-format mp3 -o "${outputAudioPath}" "${url}"`;
        exec(command, (error, stdout, stderr) => {
            if (error) return reject(error);
            resolve(outputAudioPath);
        });
    });
}

// 3. Lightweight Article Scraper (Replaced Puppeteer for Render Cloud Compatibility)
async function scrapeWebArticle(url) {
    try {
        console.log("Fetching web page via Axios + Cheerio...");
        const response = await axios.get(`${CLOUDFLARE_PROXY_URL}${encodeURIComponent(url)}`, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        const ogTitle = $('meta[property="og:title"]').attr('content') || $('title').text() || '';
        const ogDesc = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
        const bodyText = $('body').text().replace(/\s+/g, ' ').slice(0, 2500);

        return `${ogTitle}\n${ogDesc}\n${bodyText}`.trim();
    } catch (err) {
        console.error("Cheerio Scraping Failed:", err.message);
        return null;
    }
}

// -------------------------------------------------------------
// 1. TEXT, LINK & ARTICLE FACT-CHECK ENDPOINT
// -------------------------------------------------------------
app.post('/api/check-text', async (req, res) => {
    const { text } = req.body;
    if (!text) {
        return res.status(400).json({ error: 'Text or claim input is required.' });
    }

    const cleanInput = text.trim();
    const isUrl = /^https?:\/\//i.test(cleanInput);
    let transcript = cleanInput;

    if (isUrl) {
        console.log("Processing URL input:", cleanInput);

        const isMetaLink = /instagram\.com|facebook\.com|fb\.watch/i.test(cleanInput);
        const isYouTubeLink = /youtube\.com|youtu\.be/i.test(cleanInput);

        // ROUTE 1: Instagram & Facebook -> RapidAPI
        if (isMetaLink) {
            console.log("Detected Meta Link (Insta/FB). Extracting via RapidAPI...");
            const socialContent = await fetchSocialMediaMetadata(cleanInput);
            if (socialContent && socialContent.length > 5) {
                transcript = socialContent;
            } else {
                return res.status(400).json({ 
                    error: 'Unable to extract link. Post may be private or protected.' 
                });
            }
        } 
        // ROUTE 2: YouTube -> Audio Download + Speech Transcription
        else if (isYouTubeLink) {
            console.log("Detected YouTube Link. Downloading audio & transcribing...");
            const audioFilename = `yt_${Date.now()}.mp3`;
            const audioPath = path.join('uploads', audioFilename);

            try {
                await downloadAudioFromUrl(cleanInput, audioPath);
                transcript = await transcribeAudio(audioPath);
                if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
            } catch (ytErr) {
                if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
                return res.status(400).json({ 
                    error: 'Failed to transcribe YouTube audio.' 
                });
            }
        } 
        // ROUTE 3: General Websites / Articles -> Cheerio Proxy Scraper
        else {
            console.log("Detected General Web Article. Scraping content...");
            const articleText = await scrapeWebArticle(cleanInput);
            if (articleText && articleText.length > 20) {
                transcript = articleText;
            } else {
                return res.status(400).json({ 
                    error: 'Unable to scrape website text. Please copy-paste the text content directly!' 
                });
            }
        }
    }

    // AI Analysis with Groq
    try {
        console.log("Analyzing claim with Groq AI...");
        const completion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: `You are NoCap.dev, a Gen-Z viral fact-checker. Respond ONLY with valid JSON.
                    
RATING RUBRIC:
- 9 to 10 (NO CAP): 100% Factually verified, scientifically sound, no missing context.
- 5 to 8 (PARTIAL CAP): Mixed truth, clickbait exaggeration, or crucial context omitted.
- 1 to 4 (TOTAL CAP): Debunked myth, fake news, blatantly false or dangerous misinfo.`
                },
                {
                    role: "user",
                    content: `Analyze this content/claim: "${transcript}"
                    
                    Return strict JSON schema:
                    {
                      "rating": number (1 to 10),
                      "verdict": "NO CAP 🧢" | "PARTIAL CAP 🧢🧢" | "TOTAL CAP 🧢🧢🧢",
                      "factCheck": "Direct factual assessment of claims made",
                      "theCatch": "Explain missing context or exaggeration AND explicitly state the CORRECT RIGHT ANSWER/FACT here.",
                      "tldr": "Exactly 2 sentences summarizing the reality"
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
        console.error("GROQ ANALYSIS ERROR:", err);
        res.status(500).json({ error: err.message || 'Groq analysis failed.' });
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

        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

        if (!transcript || transcript.trim().length === 0) {
            return res.status(400).json({ error: 'No speech detected in video.' });
        }

        const completion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: `You are NoCap.dev, a Gen-Z viral fact-checker. Respond ONLY with valid JSON.

RATING RUBRIC:
- 9 to 10 (NO CAP): 100% Factually verified, scientifically sound, no missing context.
- 5 to 8 (PARTIAL CAP): Mixed truth, clickbait exaggeration, or crucial context omitted.
- 1 to 4 (TOTAL CAP): Debunked myth, fake news, blatantly false or dangerous misinfo.`
                },
                {
                    role: "user",
                    content: `Analyze this transcript: "${transcript}"
                    
                    Return strict JSON schema:
                    {
                      "rating": number (1 to 10),
                      "verdict": "NO CAP 🧢" | "PARTIAL CAP 🧢🧢" | "TOTAL CAP 🧢🧢🧢",
                      "factCheck": "Direct factual assessment",
                      "theCatch": "Explain missing context or exaggeration AND explicitly state the CORRECT RIGHT ANSWER/FACT here.",
                      "tldr": "Exactly 2 sentences summarizing the reality"
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
        console.error("VIDEO ANALYSIS ERROR:", err);
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

        res.status(500).json({ error: err.message || 'Video analysis failed.' });
    }
});

// -------------------------------------------------------------
// 3. AI TRANSLATION ENDPOINT
// -------------------------------------------------------------
app.post('/api/translate', async (req, res) => {
    try {
        const { targetLang, factCheck, theCatch, tldr } = req.body;

        if (!targetLang || !factCheck) {
            return res.status(400).json({ error: 'Missing translation text or language.' });
        }

        const safeFactCheck = String(factCheck || '').replace(/["']/g, '');
        const safeTheCatch = String(theCatch || '').replace(/["']/g, '');
        const safeTldr = String(tldr || '').replace(/["']/g, '');

        const completion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: `You are a professional translator. Translate the given text fields into ${targetLang}. Maintain accuracy and a modern tone. Respond ONLY in valid JSON format without markdown ticks.`
                },
                {
                    role: "user",
                    content: `Translate these fields to ${targetLang}:
                    {
                      "factCheck": "${safeFactCheck}",
                      "theCatch": "${safeTheCatch}",
                      "tldr": "${safeTldr}"
                    }
                    
                    Return strict JSON structure:
                    {
                      "factCheck": "translated factCheck text",
                      "theCatch": "translated theCatch text",
                      "tldr": "translated tldr text"
                    }`
                }
            ],
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
            temperature: 0.1
        });

        const rawResult = completion.choices[0].message.content;
        const parsedData = JSON.parse(rawResult);

        return res.json(parsedData);

    } catch (err) {
        console.error("[TRANSLATION SERVER ERROR]:", err.message);
        return res.status(500).json({ 
            error: "Translation failed on server", 
            details: err.message 
        });
    }
});

// -------------------------------------------------------------
// 4. AI CHATBOT ASSISTANT ENDPOINT
// -------------------------------------------------------------
app.post('/api/chat-assistant', async (req, res) => {
    const { message, mode } = req.body;
    
    if (!message) {
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

// -------------------------------------------------------------
// SERVER LISTENER & GLOBAL CRASH PREVENTION
// -------------------------------------------------------------
const PORT = process.env.PORT || 5001;

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`=================================`);
    console.log(`markiv.site Server RUNNING on http://localhost:${PORT}`);
    console.log(`=================================`);
});

server.timeout = 300000;

process.on('uncaughtException', (err) => {
    console.error('CRITICAL ERROR (Uncaught Exception):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL ERROR (Unhandled Rejection):', reason);
});