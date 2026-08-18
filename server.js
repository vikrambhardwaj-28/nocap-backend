require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const axios = require('axios');
const Groq = require('groq-sdk');
const { GoogleGenAI } = require('@google/genai');
const { Mistral } = require('@mistralai/mistralai');
const Tesseract = require('tesseract.js');
const ffmpegPath = require('ffmpeg-static');
const { extractAudio, transcribeAudio } = require('./audioService');

const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static('public'));

if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 100 * 1024 * 1024 }
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

const PROMPT_TEMPLATE = (claim) => `You are an elite investigative fact-checker. 
Do NOT rely merely on viral popularity or surface-level claims. Perform deep, rigorous verification focused on primary evidence, scientific data, and logical consistency.

CLAIM TO VERIFY: "${claim}"

RATING RUBRIC:
- 9 to 10 (NO CAP): 100% Factually verified, scientifically sound, zero missing context.
- 5 to 8 (PARTIAL CAP): Mixed truth, clickbait exaggeration, misleading stats, or critical context omitted.
- 1 to 4 (TOTAL CAP): Debunked myth, fake news, manipulated media, or harmful propaganda.

Return strict JSON schema only:
{
  "rating": number (1 to 10),
  "verdict": "NO CAP 🧢" | "PARTIAL CAP 🧢🧢" | "TOTAL CAP 🧢🧢🧢",
  "factCheck": "Deep investigative factual assessment exposing why the claim is true or false.",
  "theCatch": "Explicitly identify the distortion, missing context, and state the objective verified truth.",
  "tldr": "Exactly 2 concise sentences summarizing the reality."
}`;

async function analyzeWithMultiAgent(claimText) {
    const withTimeout = (promise, agentName, ms = 15000) => {
        const timeout = new Promise((resolve) =>
            setTimeout(() => {
                console.warn(`[TIMEOUT] ${agentName} took too long (> ${ms}ms).`);
                resolve(null);
            }, ms)
        );
        return Promise.race([promise, timeout]);
    };

    const runGroq = async () => {
        try {
            const completion = await groq.chat.completions.create({
                messages: [
                    { role: "system", content: "You are an objective fact-checking engine. Output strict JSON only." },
                    { role: "user", content: PROMPT_TEMPLATE(claimText) }
                ],
                model: "llama-3.3-70b-versatile",
                response_format: { type: "json_object" },
                temperature: 0.1
            });
            return JSON.parse(completion.choices[0].message.content);
        } catch (e) {
            console.error("[AGENT GROQ ERROR]:", e.message);
            return null;
        }
    };

    const runGemini = async () => {
        try {
            const response = await ai.models.generateContent({
                model: 'gemini-3.6-flash',
                contents: PROMPT_TEMPLATE(claimText),
                config: { responseMimeType: 'application/json' }
            });
            return JSON.parse(response.text);
        } catch (e) {
            console.error("[AGENT GEMINI ERROR]:", e.message);
            return null;
        }
    };

    const runMistral = async () => {
        try {
            const response = await mistral.chat.complete({
                model: "mistral-large-latest",
                messages: [
                    { role: "system", content: "You are an objective fact-checking engine. Output strict JSON only." },
                    { role: "user", content: PROMPT_TEMPLATE(claimText) }
                ],
                responseFormat: { type: "json_object" },
                temperature: 0.1
            });
            return JSON.parse(response.choices[0].message.content);
        } catch (e) {
            console.error("[AGENT MISTRAL ERROR]:", e.message);
            return null;
        }
    };

    const [resGroq, resGemini, resMistral] = await Promise.all([
        withTimeout(runGroq(), "Groq"),
        withTimeout(runGemini(), "Gemini"),
        withTimeout(runMistral(), "Mistral")
    ]);

    const validResults = [resGroq, resGemini, resMistral].filter(
        (r) => r && typeof r.rating === 'number'
    );

    if (validResults.length === 0) {
        const fallback = await runGroq();
        if (!fallback) throw new Error("Fact check service is temporarily unavailable.");
        validResults.push(fallback);
    }

    const avgRating = Math.round(
        validResults.reduce((acc, curr) => acc + curr.rating, 0) / validResults.length
    );

    let consensusVerdict = "NO CAP 🧢";
    if (avgRating <= 4) consensusVerdict = "TOTAL CAP 🧢🧢🧢";
    else if (avgRating <= 8) consensusVerdict = "PARTIAL CAP 🧢🧢";

    const primaryReport = resGroq || resGemini || resMistral || validResults[0];

    return {
        rating: avgRating,
        verdict: consensusVerdict,
        factCheck: primaryReport.factCheck,
        theCatch: primaryReport.theCatch,
        tldr: primaryReport.tldr,
        agentsParticipated: validResults.length
    };
}

async function downloadAudioFromUrl(url, outputAudioPath) {
    const cleanUrl = url.trim();

    try {
        await new Promise((resolve, reject) => {
            const ytDlpExecutable = fs.existsSync('./yt-dlp') ? './yt-dlp' : 'yt-dlp';
            const command = `${ytDlpExecutable} --ffmpeg-location "${ffmpegPath}" --extractor-args "youtube:player_client=android,web" --user-agent "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15" -x --audio-format mp3 -o "${outputAudioPath}" "${cleanUrl}"`;
            
            exec(command, { timeout: 45000 }, (error) => {
                if (error) return reject(error);
                resolve();
            });
        });

        if (fs.existsSync(outputAudioPath) && fs.statSync(outputAudioPath).size > 1000) {
            return outputAudioPath;
        }
    } catch (ytErr) {
        console.warn("[AUDIO] yt-dlp fallback triggered.");
    }

    try {
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

        const writer = fs.createWriteStream(outputAudioPath);
        const streamRes = await axios.get(audioStreamUrl, { responseType: 'stream', timeout: 30000 });

        await new Promise((resolve, reject) => {
            streamRes.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        if (fs.existsSync(outputAudioPath) && fs.statSync(outputAudioPath).size > 1000) {
            return outputAudioPath;
        } else {
            throw new Error("Downloaded audio file is empty.");
        }

    } catch (cobaltErr) {
        console.error("[AUDIO] Streamer Error:", cobaltErr.message);
        throw new Error("Failed to extract audio from all engines.");
    }
}

app.post('/api/check-text', async (req, res) => {
    const { text } = req.body;
    if (!text) {
        return res.status(400).json({ error: 'Text or claim input is required.' });
    }

    const cleanInput = text.trim();
    const isUrl = /^https?:\/\//i.test(cleanInput);
    let transcript = cleanInput;

    if (isUrl) {
        const audioFilename = `audio_${Date.now()}.mp3`;
        const audioPath = path.join('uploads', audioFilename);

        try {
            await downloadAudioFromUrl(cleanInput, audioPath);
            const audioTranscript = await transcribeAudio(audioPath);

            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

            if (!audioTranscript || audioTranscript.trim().length === 0) {
                return res.status(400).json({ 
                    error: 'No speech detected in the audio of this link.' 
                });
            }

            transcript = audioTranscript;
        } catch (err) {
            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
            return res.status(400).json({ 
                error: 'Failed to extract audio speech from this link. The video might be private or restricted.' 
            });
        }
    }

    try {
        const result = await analyzeWithMultiAgent(transcript);
        res.json({ ...result, transcript: isUrl ? transcript : undefined });
    } catch (err) {
        console.error("ANALYSIS ERROR:", err);
        res.status(500).json({ error: err.message || 'Multi-Agent analysis failed.' });
    }
});

app.post('/api/check-image', upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image file provided.' });
    }

    const imagePath = req.file.path;

    try {
        const { data: { text } } = await Tesseract.recognize(imagePath, 'eng+hin');

        if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);

        const extractedText = text.trim();
        if (!extractedText || extractedText.length < 5) {
            return res.status(400).json({ error: 'No readable text or claim found in the uploaded image.' });
        }

        const result = await analyzeWithMultiAgent(extractedText);
        res.json({ ...result, transcript: extractedText });

    } catch (err) {
        console.error("IMAGE ANALYSIS ERROR:", err);
        if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
        res.status(500).json({ error: err.message || 'Image analysis failed.' });
    }
});

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
            return res.status(400).json({ error: 'No speech detected in uploaded video.' });
        }

        const result = await analyzeWithMultiAgent(transcript);
        res.json({ ...result, transcript });

    } catch (err) {
        console.error("VIDEO ANALYSIS ERROR:", err);
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

        res.status(500).json({ error: err.message || 'Video processing failed.' });
    }
});

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

const PORT = process.env.PORT || 5001;

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`markiv.site Multi-Agent Fact Checker RUNNING on http://localhost:${PORT}`);
});

server.timeout = 300000;

process.on('uncaughtException', (err) => {
    console.error('CRITICAL ERROR (Uncaught Exception):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL ERROR (Unhandled Rejection):', reason);
});