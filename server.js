require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const cheerio = require('cheerio');
const axios = require('axios');
const puppeteer = require('puppeteer');
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

const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 50 * 1024 * 1024 }
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// -------------------------------------------------------------
// HELPER FUNCTIONS
// -------------------------------------------------------------

// 1. Video Links (yt-dlp)
function downloadAudioFromUrl(url, outputAudioPath) {
    return new Promise((resolve, reject) => {
        const command = `yt-dlp -x --audio-format mp3 -o "${outputAudioPath}" "${url}"`;
        exec(command, (error, stdout, stderr) => {
            if (error) return reject(error);
            resolve(outputAudioPath);
        });
    });
}

// 2. Puppeteer Headless Scraper for Facebook/Private/JS-heavy Links
async function scrapeWithPuppeteer(url) {
    let browser = null;
    try {
        console.log("Launching Headless Browser for JS rendering...");
        browser = await puppeteer.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        
        // Emulate desktop browser to bypass standard bot checks
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        
        // Wait 2 seconds for JS/Redirects to settle
        await new Promise(r => setTimeout(r, 2000));

        const extractedText = await page.evaluate(() => {
            const ogTitle = document.querySelector('meta[property="og:title"]')?.content || '';
            const ogDesc = document.querySelector('meta[property="og:description"]')?.content || '';
            const metaDesc = document.querySelector('meta[name="description"]')?.content || '';
            const bodyText = document.body.innerText || '';

            return `${ogTitle}\n${ogDesc}\n${metaDesc}\n${bodyText}`.slice(0, 3000);
        });

        await browser.close();
        return extractedText.trim();
    } catch (err) {
        console.error("Puppeteer Scraping Failed:", err.message);
        if (browser) await browser.close();
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

    const isUrl = /^https?:\/\//i.test(text.trim());
    let transcript = text;

    if (isUrl) {
        console.log("Processing URL input:", text);
        const audioFilename = `link_${Date.now()}.mp3`;
        const audioPath = path.join('uploads', audioFilename);

        // Attempt 1: Video/Reel Audio Extraction (yt-dlp)
        try {
            console.log("Attempt 1: Trying yt-dlp audio download...");
            await downloadAudioFromUrl(text.trim(), audioPath);
            transcript = await transcribeAudio(audioPath);
            console.log("Audio transcript received from yt-dlp.");
        } catch (videoErr) {
            console.log("Attempt 1 failed (Not a video). Trying Headless Browser (Puppeteer)...");
            
            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

            // Attempt 2: Puppeteer Headless Scraping for Facebook/Articles
            const puppeteerText = await scrapeWithPuppeteer(text.trim());
            
            if (puppeteerText && puppeteerText.length > 20) {
                transcript = puppeteerText;
                console.log("Puppeteer extracted page content successfully.");
            } else {
                return res.status(400).json({ 
                    error: 'Facebook/Post requires login or is private. Please copy-paste the text/caption directly!' 
                });
            }
        }
    }

    // Groq Fact Checking
    try {
        console.log("Analyzing content with Groq...");
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
                      "theCatch": "Context missing, exaggerated claims, or hidden details",
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
                      "theCatch": "Context missing, exaggerated claims, or hidden details",
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
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

        res.status(500).json({ error: err.message || 'Video analysis failed.' });
    }
});

const PORT = process.env.PORT || 5001;
// -------------------------------------------------------------
// 3. AI CHATBOT ASSISTANT ENDPOINT
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
// Change PORT variable name to avoid duplicate identifier errors
const PORT_NO = process.env.PORT || 5001;

app.listen(PORT_NO, '0.0.0.0', () => {
    console.log(`NoCap Server running on port ${PORT_NO}`);
});