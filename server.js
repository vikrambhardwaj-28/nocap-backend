require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const axios = require('axios');
const Groq = require('groq-sdk');
const ffmpegPath = require('ffmpeg-static');
const { extractAudio, transcribeAudio } = require('./audioService');

const app = express();

// Middleware Setup
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Multer Configured for Video & Image Uploads (100MB Limit)
const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 100 * 1024 * 1024 }
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// =============================================================
// UNIFIED AUDIO DOWNLOADER ENGINE (yt-dlp + Cobalt Streamer)
// =============================================================
async function downloadAudioFromUrl(url, outputAudioPath) {
    const cleanUrl = url.trim();

    // METHOD 1: Try local yt-dlp audio download
    try {
        console.log("[AUDIO] Attempt 1: Downloading audio with yt-dlp...");
        await new Promise((resolve, reject) => {
            const ytDlpExecutable = fs.existsSync('./yt-dlp') ? './yt-dlp' : 'yt-dlp';
            const command = `${ytDlpExecutable} --ffmpeg-location "${ffmpegPath}" --extractor-args "youtube:player_client=android,web" --user-agent "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15" -x --audio-format mp3 -o "${outputAudioPath}" "${cleanUrl}"`;
            
            exec(command, { timeout: 45000 }, (error) => {
                if (error) return reject(error);
                resolve();
            });
        });

        if (fs.existsSync(outputAudioPath) && fs.statSync(outputAudioPath).size > 1000) {
            console.log("[AUDIO] SUCCESS via yt-dlp!");
            return outputAudioPath;
        }
    } catch (ytErr) {
        console.log("[AUDIO] yt-dlp failed (Datacenter IP Block). Switching to Cobalt Audio Streamer...");
    }

    // METHOD 2: Cobalt API (Bypasses Render IP block & fetches direct MP3 file)
    try {
        console.log("[AUDIO] Attempt 2: Downloading MP3 stream via Cobalt Engine...");
        const response = await axios.post('https://api.cobalt.tools/api/json', {
            url: cleanUrl,
            downloadMode: "audio",
            audioFormat: "mp3"
        }, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            timeout: 20000
        });

        const audioStreamUrl = response.data?.url;
        if (!audioStreamUrl) {
            throw new Error("No audio stream URL returned from Cobalt");
        }

        console.log("[AUDIO] Streaming MP3 to local uploads folder...");
        const writer = fs.createWriteStream(outputAudioPath);
        const streamRes = await axios.get(audioStreamUrl, { responseType: 'stream', timeout: 30000 });

        await new Promise((resolve, reject) => {
            streamRes.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        if (fs.existsSync(outputAudioPath) && fs.statSync(outputAudioPath).size > 1000) {
            console.log("[AUDIO] SUCCESS via Cobalt Streamer!");
            return outputAudioPath;
        } else {
            throw new Error("Downloaded audio file is empty.");
        }

    } catch (cobaltErr) {
        console.error("[AUDIO] Cobalt Streamer Error:", cobaltErr.message);
        throw new Error("Failed to extract audio from all engines.");
    }
}

// =============================================================
// 1. UNIFIED URL & TEXT FACT-CHECK ENDPOINT
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
        console.log("--------------------------------------------------");
        console.log("Processing URL (Audio ➔ Speech-to-Text Pipeline):", cleanInput);
        
        const audioFilename = `audio_${Date.now()}.mp3`;
        const audioPath = path.join('uploads', audioFilename);

        try {
            console.log("Step 1: Downloading Audio File...");
            await downloadAudioFromUrl(cleanInput, audioPath);

            console.log("Step 2: Transcribing Audio Speech to Text via Whisper...");
            const audioTranscript = await transcribeAudio(audioPath);

            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

            if (!audioTranscript || audioTranscript.trim().length === 0) {
                return res.status(400).json({ 
                    error: 'No speech detected in the audio of this link.' 
                });
            }

            transcript = audioTranscript;
            console.log("Step 2 Completed. Speech Transcript:", transcript.slice(0, 150) + "...");

        } catch (err) {
            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
            console.error("Audio Speech Pipeline Error:", err.message);
            return res.status(400).json({ 
                error: 'Failed to extract audio speech from this link. The video might be private or restricted.' 
            });
        }
    }

    try {
        console.log("Step 3: Analyzing Transcribed Speech via Groq AI...");
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
        console.log("Step 3 Completed successfully.");
        console.log("--------------------------------------------------");

        res.json({ ...jsonResult, transcript: isUrl ? transcript : undefined });

    } catch (err) {
        console.error("GROQ ANALYSIS ERROR:", err);
        res.status(500).json({ error: err.message || 'Groq AI analysis failed.' });
    }
});

// =============================================================
// 2. DIRECT VIDEO FILE UPLOAD ENDPOINT
// =============================================================
app.post('/api/check-video', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No video file provided.' });
    }

    const videoPath = req.file.path;
    const audioPath = path.join('uploads', `${req.file.filename}.mp3`);

    try {
        console.log("Extracting audio from uploaded video file...");
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
// 3. IMAGE / SCREENSHOT FACT-CHECK ENDPOINT (UPDATED VISION MODEL)
// =============================================================
app.post('/api/check-image', upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image file provided.' });
    }

    const imagePath = req.file.path;

    try {
        console.log("Processing uploaded image for text extraction & fact-check...");
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');
        const mimeType = req.file.mimetype || 'image/jpeg';

        console.log("Analyzing image via Groq Vision AI...");
        const completion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: `You are NoCap.dev, a Gen-Z viral fact-checker. 
Read the text, headline, meme, or claim shown in this image, extract the claim, and fact-check it with 100% precision. 
Respond ONLY with valid JSON.

RATING RUBRIC:
- 9 to 10 (NO CAP): 100% Factually verified, scientifically sound, no missing context.
- 5 to 8 (PARTIAL CAP): Mixed truth, clickbait exaggeration, or crucial context omitted.
- 1 to 4 (TOTAL CAP): Debunked myth, fake news, blatantly false or dangerous misinfo.`
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `Extract the text/claim from this image and fact-check it.
                            
Return strict JSON schema:
{
  "rating": number (1 to 10),
  "verdict": "NO CAP 🧢" | "PARTIAL CAP 🧢🧢" | "TOTAL CAP 🧢🧢🧢",
  "factCheck": "Direct factual assessment of the text/claim written on the image",
  "theCatch": "Explain missing context or exaggeration AND explicitly state the CORRECT RIGHT ANSWER/FACT here.",
  "tldr": "Exactly 2 sentences summarizing the reality",
  "extractedText": "The actual text read from the image"
}`
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:${mimeType};base64,${base64Image}`
                            }
                        }
                    ]
                }
            ],
            model: "meta-llama/llama-4-scenic-instruct",
            response_format: { type: "json_object" },
            temperature: 0.2
        });

        if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);

        const jsonResult = JSON.parse(completion.choices[0].message.content);
        res.json({ ...jsonResult, transcript: jsonResult.extractedText });

    } catch (err) {
        console.error("IMAGE ANALYSIS ERROR:", err);
        if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
        res.status(500).json({ error: err.message || 'Image analysis failed.' });
    }
});

// =============================================================
// 4. AI TRANSLATION ENDPOINT
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
// 5. AI CHATBOT ASSISTANT ENDPOINT
// =============================================================
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

// =============================================================
// SERVER LISTENER & CRASH PREVENTION
// =============================================================
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