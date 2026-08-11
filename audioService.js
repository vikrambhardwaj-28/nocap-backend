const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const Groq = require('groq-sdk');
const fs = require('fs');

// FFmpeg Path Set
ffmpeg.setFfmpegPath(ffmpegPath);

// Initialize Groq SDK (Uses GROQ_API_KEY from .env)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * Video File से Audio (.mp3) Extract करने का फ़ंक्शन
 */
function extractAudio(videoPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .noVideo() // Strips video track (Correct syntax)
            .audioCodec('libmp3lame')
            .toFormat('mp3')
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .save(outputPath);
    });
}

/**
 * Groq Whisper API (whisper-large-v3-turbo) का यूज़ करके Audio को Text में बदलने का फ़ंक्शन
 */
async function transcribeAudio(audioFilePath) {
    try {
        const fileStream = fs.createReadStream(audioFilePath);
        
        // Groq API से audio transcribe करें (100% Fast & Free)
        const transcription = await groq.audio.transcriptions.create({
            file: fileStream,
            model: 'whisper-large-v3-turbo', 
        });

        // Close Stream & Cleanup Audio File
        fileStream.destroy(); 
        if (fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
        
        return transcription.text;
    } catch (error) {
        // Cleanup Audio File on Failure
        if (fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
        throw error;
    }
}

module.exports = { extractAudio, transcribeAudio };