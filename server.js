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
const ffmpegPath = require('ffmpeg-static');
const { extractAudio, transcribeAudio } = require('./audioService');

const app = express();

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Multer configured for video file uploads (100MB Limit)
const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 100 * 1024 * 1024 }
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Cloudflare Proxy Fallback Configuration
const CLOUDFLARE_PROXY_URL = 'https://nocap-proxy.vikram-2872006.workers.dev?url=';

// =============================================================
// HELPER FUNCTIONS (ROBUST AUDIO & TEXT PIPELINE)
// =============================================================

// 1. Enhanced Audio Downloader for YouTube, Facebook & Instagram via yt-dlp
function downloadAudioFromUrl(url, outputAudioPath) {
    return new Promise((resolve, reject) => {
        const ytDlpExecutable = fs.existsSync('./yt-dlp') ? './yt-dlp' : 'yt-dlp';
        
        // Clean URL parameters that break tracking (keeping necessary video IDs)
        const cleanUrl = url.trim();

        console.log(`Downloading audio using ${ytDlpExecutable} for URL:`, cleanUrl);

        // Advanced yt-dlp command with Android/Web client spoofing and mobile user agent to bypass cloud blocks
        const command = `${ytDlpExecutable} --ffmpeg-location "${ffmpegPath}" --extractor-args "youtube:player_client=android,web" --user-agent "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1" -x --audio-format mp3 -o "${outputAudioPath}" "${cleanUrl}"`;
        
        exec(command, { timeout: 60000 }, (error, stdout, stderr) => {
            if (error) {
                console.error("yt-dlp execution error:", error.message);
                return reject(error);
            }
            resolve(outputAudioPath);
        });
    });
}

// 2. Smart Metadata & Caption Fallback (For YouTube, Facebook & Instagram)
async function fetchCaptionFallback(url) {
    try {
        console.log("Fallback: Extracting OpenGraph Metadata/Captions...");
        const cleanUrl = url.split('?')[0].replace(/\/$/, "");
        
        // Try Cloudflare Proxy or direct Axios with mobile UA
        const response = await axios.get(`${CLOUDFLARE_PROXY_URL}${encodeURIComponent(url)}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15'
            },
            timeout: 10000
        });

        const $ = cheerio.load(response.data);
        const title = $('meta[property="og:title"]').attr('content') || $('title').text() || '';
        const description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
        const caption = $('.Caption').text() || '';

        const fullText = `${title}\n${description}\n${caption}`.replace(/\s+/g, ' ').trim();
        return fullText.length > 5 ? fullText : null;
    } catch (err) {
        console.error("Fallback Extraction Failed:", err.message);
        return null;
    }
}

// =============================================================
// 1. TEXT, LINK & ARTICLE FACT-CHECK ENDPOINT
// =============================================================
app.post('/api/check-text', async (req, res) => {
    const { text } = req.body;
    if (!text) {
        return res.status(400).json({ error: 'Text or claim input is required.' });
    }

    const cleanInput = text.trim();
    const isUrl = /^https?:\/\//i.test(cleanInput);
    let transcript = cleanInput;

    if (isUrl) {
        console.log("Processing URL Input:", cleanInput);
        const audioFilename = `media_audio_${Date.now()}.mp3`;
        const audioPath = path.join('uploads', audioFilename);

        let audioExtractedSuccessfully = false;

        // STEP 1: Attempt Audio Download & Speech-to-Text Transcription (Main Logic)
        try {
            console.log("Attempting audio extraction & speech transcription...");
            await downloadAudioFromUrl(cleanInput, audioPath);

            console.log("Transcribing audio speech to text via Whisper...");
            const audioTranscript = await transcribeAudio(audioPath);

            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

            if (audioTranscript && audioTranscript.trim().length > 5) {
                transcript = audioTranscript;
                audioExtractedSuccessfully = true;
                console.log("SUCCESS: Audio successfully transcribed to text!");
            }
        } catch (audioErr) {
            console.log("Audio download/transcription restricted or failed. Falling back to metadata...");
            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        }

        // STEP 2: Fallback to Caption / Metadata if Audio Extraction Fails
        if (!audioExtractedSuccessfully) {
            const fallbackText = await fetchCaptionFallback(cleanInput);
            if (fallbackText && fallbackText.length > 5) {
                transcript = fallbackText;
                console.log("SUCCESS: Retrieved text via metadata fallback.");
            } else {
                return res.status(400).json({ 
                    error: 'Unable to extract audio speech or caption from link. The video might be private, age-restricted, or geo-blocked.' 
                });
            }
        }
    }

    // STEP 3: AI Fact-Checking Engine via Groq
    try {
        console.log("Analyzing content with Groq AI...");
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
                    content: `Analyze this content/claim transcript: "${transcript}"
                    
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
        res.status(500).json({ error: err.message || 'Groq AI analysis failed.' });
    }
});

// =============================================================
// 2. VIDEO FILE UPLOAD ENDPOINT
// =============================================================
app.post('/api/check-video', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No video file provided.' });
    }

    const videoPath = req.file.path;
    const audioPath = path.join('uploads', `${req.file.filename}.mp3`);

    try {
        console.log("Extracting audio from uploaded video...");
        await extractAudio(videoPath, audioPath);
        
        console.log("Transcribing extracted audio...");
        const transcript = await transcribeAudio(audioPath);

        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

        if (!transcript || transcript.trim().length === 0) {
            return res.status(400).json({ error: 'No speech detected in uploaded video.' });
        }

        console.log("Analyzing transcript with Groq AI...");
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

        res.status(500).json({ error: err.message || 'Video processing failed.' });
    }
});

// =============================================================
// 3. AI TRANSLATION ENDPOINT
// =============================================================
app.post('/api/translate', async (req, res) => {
    try {
        const { targetLang, factCheck, theCatch, tldr } = req.body;

        if (!targetLang || !factCheck) {
            return res.status(400).json({ error: 'Missing target language or fact-check content.' });
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
        console.error("[TRANSLATION ERROR]:", err.message);
        return res.status(500).json({ 
            error: "Translation failed on server", 
            details: err.message 
        });
    }
});

// =============================================================
// 4. AI CHATBOT ASSISTANT ENDPOINT
// =============================================================
app.post('/api/chat-assistant', async (req, res) => {
    const { message, mode } = req.body;
    
    if (!message) {
        return res.status(400).json({ reply: "Please type a valuable message." });
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

// =============================================================
// SERVER LISTENER & CRASH PROTECTION
// =============================================================
const PORT = process.env.PORT || 5001;

const server = app.listen(PORT, '0.0.0.0', () => {
    coutLog = `=================================\nmarkiv.site Server RUNNING on http://localhost:${PORT}\n=================================`;
    console.log(coutLog);
});

server.timeout = 300000;

process.on('uncaughtException', (err) => {
    console.error('CRITICAL ERROR (Uncaught Exception):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL ERROR (Unhandled Rejection):', reason);
});