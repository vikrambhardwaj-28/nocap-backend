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

// Helper to safely cleanup temp files
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

// -------------------------------------------------------------
// UNIVERSAL SCRAPER (INSTAGRAM, FACEBOOK, YOUTUBE & WEB)
// -------------------------------------------------------------
async function extractUniversalContent(url) {
    console.log("Processing Universal Content Extraction for URL:", url);

    // 1. YouTube Specific Fast oEmbed API (Never Blocked by Datacenter IPs)
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
        try {
            console.log("Trying YouTube oEmbed API...");
            const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
            const response = await axios.get(oembedUrl, { timeout: 5000 });
            if (response.data && response.data.title) {
                return `Platform: YouTube\nTitle: ${response.data.title}\nChannel: ${response.data.author_name}`;
            }
        } catch (e) {
            console.log("YouTube oEmbed skipped/failed.");
        }
    }

    // 2. Jina AI Reader (Bypasses IG, FB & YT Datacenter IP Blocks for Image & Video Posts)
    try {
        console.log("Fetching content via Jina AI Reader Engine...");
        const jinaUrl = `https://r.jina.ai/${url}`;
        const response = await axios.get(jinaUrl, {
            headers: {
                'Accept': 'application/json',
                'X-With-Generated-Alt': 'true' // Generates OCR text for Image posts
            },
            timeout: 12000
        });

        if (response.data && response.data.data) {
            const pageData = response.data.data;
            const title = pageData.title || '';
            const content = pageData.content || '';

            const extractedText = `Title: ${title}\nContent & Caption: ${content}`.slice(0, 3000);
            
            if (extractedText.length > 30) {
                console.log("Jina AI Reader successfully extracted post/image content!");
                return extractedText;
            }
        }
    } catch (jinaErr) {
        console.log("Jina AI Reader failed/timed out:", jinaErr.message);
    }

    // 3. Fallback: Fast Axios OpenGraph Scrape
    try {
        console.log("Fallback: Direct OpenGraph Scrape...");
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            },
            timeout: 6000
        });

        const $ = cheerio.load(response.data);
        const ogTitle = $('meta[property="og:title"]').attr('content') || $('title').text() || '';
        const ogDesc = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';

        const metaText = `Title: ${ogTitle}\nCaption/Description: ${ogDesc}`.trim();
        if (metaText.length > 25) {
            return metaText;
        }
    } catch (e) {
        console.log("OpenGraph fallback failed.");
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
            console.log("Processing URL request:", trimmedInput);

            // Step A: Extract Post Captions/Text/OCR from IG, FB, YT via Universal Extractor
            const postContent = await extractUniversalContent(trimmedInput) || '';

            // Step B: Try Audio Extraction if it's a Video/Reel
            let audioTranscript = '';
            try {
                console.log("Attempting Audio extraction with yt-dlp...");
                await downloadAudioFromUrl(trimmedInput, tempAudioPath);
                audioTranscript = await transcribeAudio(tempAudioPath);
                console.log("Audio speech transcribed successfully.");
            } catch (audioErr) {
                console.log("No downloadable audio stream found or speech absent.");
            }

            // Step C: Merge Extracted Post Text + Spoken Audio Transcript
            if (audioTranscript && audioTranscript.trim().length > 0) {
                transcript = `Post Details & Caption:\n${postContent}\n\nSpoken Audio Transcript:\n${audioTranscript}`;
            } else if (postContent && postContent.trim().length > 20) {
                transcript = `Post Details & Caption:\n${postContent}`;
            } else {
                return res.status(400).json({ 
                    error: 'Social media post content is completely private or restricted. Please copy-paste the text/caption directly!' 
                });
            }

        } catch (err) {
            console.error("URL Processing Error:", err);
            return res.status(400).json({ 
                error: 'Unable to extract post data automatically. Please copy-paste the claim text directly!' 
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
  "factCheck": "Direct factual assessment of the claims made",
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

// Health check endpoint for Cron-Job.org (Prevents Render Sleep Mode)
app.get('/health', (req, res) => {
    res.status(200).send('Server is active');
});

// Start Server
const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`markiv.site Server running on port ${PORT}`);
});