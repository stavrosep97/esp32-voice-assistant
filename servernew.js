//UPDATED VERSION READ CHANGELOG.MD FOR INSTRUCTION...

const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');

require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Configure multer for handling audio uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit
    }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));


class AudioQueue {
    constructor() {
        this.queue = [];
        this.currentAudio = null;
        this.isProcessing = false;
    }

    // Προσθήκη στην ουρά
    addToQueue(username, transcription, response, audioBuffer) {
        const queueItem = {
            id: Date.now() + Math.random(), // Unique ID
            username: username || 'Χρήστης',
            transcription: transcription,
            response: response,
            audioBuffer: audioBuffer,
            timestamp: new Date().toISOString(),
            status: 'waiting' // waiting, playing, completed
        };
        
        this.queue.push(queueItem);
        console.log(`[QUEUE] Νέα ερώτηση από ${queueItem.username}. Ουρά: ${this.queue.length}`);
        
        return queueItem.id;
    }

    // Παίρνει το επόμενο audio gia το ESP32
    getNextAudio() {
        if (this.currentAudio) {
            return this.currentAudio;
        }

        if (this.queue.length > 0) {
            this.currentAudio = this.queue.shift();
            this.currentAudio.status = 'playing';
            console.log(`[QUEUE] Παίζει απάντηση για: ${this.currentAudio.username}`);
            return this.currentAudio;
        }

        return null;
    }

    // Ολοκλήρωση playback
    completeCurrentAudio() {
        if (this.currentAudio) {
            console.log(`[QUEUE] Ολοκληρώθηκε: ${this.currentAudio.username}`);
            this.currentAudio = null;
        }
    }

    // Πληροφορίες ουράς
    getQueueStatus() {
        return {
            queueLength: this.queue.length,
            isPlaying: this.currentAudio !== null,
            currentlyPlaying: this.currentAudio ? {
                username: this.currentAudio.username,
                transcription: this.currentAudio.transcription
            } : null
        };
    }

    // Έλεγχος av υπάρχει audio έτοιμο
    hasAudioReady() {
        return this.queue.length > 0 || this.currentAudio !== null;
    }
}

const audioQueue = new AudioQueue();

// Server state
let espConnected = false;
let currentProcessing = false;


// ESP ping endpoint
app.get('/ping', (req, res) => {
    espConnected = true;
    res.json({ status: 'pong' });
});

// Endpoint για έλεγχο αν το audio είναι έτοιμο
app.get('/checkVariable', (req, res) => {
    const hasAudio = audioQueue.hasAudioReady();
    res.json({ ready: hasAudio });
});

// Endpoint για αποστολή audio στο ESP32
app.get('/broadcastAudio', (req, res) => {
    const audioItem = audioQueue.getNextAudio();
    
    if (!audioItem) {
        return res.status(404).json({ error: 'No audio available' });
    }
    
    console.log(`[ESP32] Στέλνω audio για: ${audioItem.username}`);
    res.set('Content-Type', 'audio/wav');
    res.send(audioItem.audioBuffer);
    
    // Μετά την αποστολή, ολοκληρώνουμε το current audio
    audioQueue.completeCurrentAudio();
});

// Endpoint για queue status (για το web interface)
app.get('/queueStatus', (req, res) => {
    res.json(audioQueue.getQueueStatus());
});




// Function to convert speech to text using OpenAI Whisper
async function speechToText(audioBlob) {
    try {
        const formData = new FormData();
        formData.append('file', audioBlob, {
            filename: 'audio.wav',
            contentType: 'audio/wav',
        });
        formData.append('model', 'whisper-1');
        formData.append('language', 'el'); // Greek language

        const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                ...formData.getHeaders()
            }
        });

        return response.data.text;
    } catch (error) {
        console.error('Speech to text error:', error.response?.data || error);
        throw error;
    }
}

// Function to get response from ChatGPT (WITH GPT-4o!)
async function getChatGPTResponse(text) {
    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: 'Είσαι ένας χρήσιμος βοηθός που απαντά στα ελληνικά. Κράτα τις απαντήσεις σου σύντομες και χρήσιμες.'
                },
                {
                    role: 'user',
                    content: text
                }
            ]
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('ChatGPT error:', error.response?.data || error);
        throw error;
    }
}

// Function to convert text to speech using OpenAI TTS
async function textToSpeech(text) {
    try {
        const response = await axios.post('https://api.openai.com/v1/audio/speech', {
            model: 'tts-1',
            voice: 'alloy',
            input: text,
            response_format: 'wav'
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            responseType: 'arraybuffer'
        });

        return Buffer.from(response.data);
    } catch (error) {
        console.error('Text to speech error:', error.response?.data || error);
        throw error;
    }
}


app.post('/processVoice', async (req, res) => {
    if (!req.body.audioData) {
        return res.status(400).json({ error: 'No audio data provided' });
    }

    const username = req.body.username || 'Χρήστης';

    try {
        console.log(`[PROCESSING] Νέα αίτηση από: ${username}`);
        
        // Convert base64 to buffer
        const base64Data = req.body.audioData.replace(/^data:audio\/wav;base64,/, '');
        const audioBlob = Buffer.from(base64Data, 'base64');
        
        // Step 1: Convert speech to text
        console.log('[WHISPER] Converting speech to text...');
        const transcription = await speechToText(audioBlob);
        console.log(`[WHISPER] Transcription: ${transcription}`);
        
        if (!transcription.trim()) {
            throw new Error('Δεν κατέστη δυνατή η αναγνώριση φωνής');
        }
        
        // Step 2: Get response from ChatGPT
        console.log('[GPT-4o] Getting response...');
        const chatResponse = await getChatGPTResponse(transcription);
        console.log(`[GPT-4o] Response: ${chatResponse}`);
        
        // Step 3: Convert response to speech
        console.log('[TTS] Converting response to speech...');
        const speechAudio = await textToSpeech(chatResponse);
        
        // Step 4: Προσθήκη στην ουρά
        const queueId = audioQueue.addToQueue(username, transcription, chatResponse, speechAudio);
        const queueStatus = audioQueue.getQueueStatus();
        
        res.json({
            success: true,
            queueId: queueId,
            transcription: transcription,
            response: chatResponse,
            queuePosition: queueStatus.queueLength + (queueStatus.isPlaying ? 1 : 0),
            message: queueStatus.queueLength === 0 && !queueStatus.isPlaying 
                ? 'Η απάντηση παίζει τώρα στο ESP32!' 
                : `Η απάντησή σας είναι στην ουρά. Θέση: ${queueStatus.queueLength}`
        });
        
    } catch (error) {
        console.error('Voice processing error:', error);
        res.status(500).json({ 
            error: 'Σφάλμα κατά την επεξεργασία', 
            details: error.message 
        });
    }
});


// WEB INTERFACE


app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Voice Assistant - Multi-User Queue System</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body {
                font-family: Arial, sans-serif;
                max-width: 800px;
                margin: 0 auto;
                padding: 20px;
                background-color: #f0f2f5;
            }
            
            .container {
                background: white;
                padding: 30px;
                border-radius: 10px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                margin-bottom: 20px;
            }
            
            h1 {
                text-align: center;
                color: #333;
            }
            
            .user-input {
                margin-bottom: 20px;
            }
            
            .user-input input {
                width: 100%;
                padding: 10px;
                font-size: 16px;
                border: 1px solid #ddd;
                border-radius: 5px;
                box-sizing: border-box;
            }
            
            .controls {
                text-align: center;
            }
            
            button {
                padding: 15px 30px;
                font-size: 18px;
                margin: 10px;
                border: none;
                border-radius: 5px;
                cursor: pointer;
                transition: all 0.3s;
            }
            
            #recordBtn {
                background-color: #4CAF50;
                color: white;
            }
            
            #stopBtn {
                background-color: #f44336;
                color: white;
                display: none;
            }
            
            button:hover:not(:disabled) {
                opacity: 0.8;
                transform: scale(1.05);
            }
            
            button:disabled {
                background-color: #cccccc;
                cursor: not-allowed;
                opacity: 1;
                transform: none;
            }
            
            #status {
                margin-top: 20px;
                padding: 15px;
                border-radius: 5px;
                margin-bottom: 20px;
                min-height: 50px;
                text-align: center;
            }
            
            .success {
                background-color: #dff0d8;
                color: #3c763d;
                border: 1px solid #d6e9c6;
            }
            
            .error {
                background-color: #f2dede;
                color: #a94442;
                border: 1px solid #ebccd1;
            }
            
            .info {
                background-color: #d9edf7;
                color: #31708f;
                border: 1px solid #bce8f1;
            }
            
            .processing {
                background-color: #fcf8e3;
                color: #8a6d3b;
                border: 1px solid #faebcc;
            }
            
            .queue-info {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                padding: 20px;
                border-radius: 10px;
                margin-bottom: 20px;
            }
            
            .queue-stats {
                display: flex;
                justify-content: space-around;
                margin-top: 15px;
            }
            
            .queue-stat {
                text-align: center;
            }
            
            .queue-stat-number {
                font-size: 32px;
                font-weight: bold;
            }
            
            .queue-stat-label {
                font-size: 14px;
                opacity: 0.9;
            }
            
            #currentlyPlaying {
                background-color: rgba(255,255,255,0.2);
                padding: 10px;
                border-radius: 5px;
                margin-top: 10px;
            }
            
            #conversation {
                margin-top: 20px;
                text-align: left;
                max-height: 400px;
                overflow-y: auto;
                border: 1px solid #ddd;
                padding: 15px;
                border-radius: 5px;
                background-color: #fafafa;
            }
            
            .message {
                margin: 10px 0;
                padding: 12px;
                border-radius: 8px;
                animation: slideIn 0.3s ease-out;
            }
            
            @keyframes slideIn {
                from {
                    opacity: 0;
                    transform: translateY(-10px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }
            
            .user-message {
                background-color: #e3f2fd;
                margin-left: 20px;
                border-left: 4px solid #2196F3;
            }
            
            .assistant-message {
                background-color: #f5f5f5;
                margin-right: 20px;
                border-left: 4px solid #4CAF50;
            }
            
            .message-user {
                font-weight: bold;
                color: #666;
                font-size: 12px;
                margin-bottom: 5px;
            }
            
            .esp-status {
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 10px;
                border-radius: 5px;
                background-color: #f5f5f5;
            }
            
            .status-dot {
                width: 12px;
                height: 12px;
                border-radius: 50%;
                margin-right: 10px;
                animation: pulse 2s infinite;
            }
            
            .status-dot.connected {
                background-color: #4CAF50;
            }
            
            .status-dot.disconnected {
                background-color: #f44336;
            }
            
            @keyframes pulse {
                0%, 100% {
                    opacity: 1;
                }
                50% {
                    opacity: 0.5;
                }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🎙️ Voice Assistant - For many users edition</h1>
            <p style="text-align: center; color: #666;">Πολλοί χρήστες μπορούν να κάνουν ερωτήσεις ταυτόχρονα!</p>
            
            <div class="queue-info">
                <h3 style="margin-top: 0;">📊 Queue Status</h3>
                <div class="queue-stats">
                    <div class="queue-stat">
                        <div class="queue-stat-number" id="queueLength">0</div>
                        <div class="queue-stat-label">Σε αναμονή</div>
                    </div>
                    <div class="queue-stat">
                        <div class="queue-stat-number" id="isPlaying">-</div>
                        <div class="queue-stat-label">Παίζει τώρα</div>
                    </div>
                </div>
                <div id="currentlyPlaying" style="display: none;">
                    <strong>🔊 Παίζει τώρα:</strong> <span id="playingUser"></span>
                    <br>
                    <small id="playingQuestion"></small>
                </div>
            </div>
            
            <div class="user-input">
                <label for="username" style="display: block; margin-bottom: 5px; color: #666;">Το όνομά σας:</label>
                <input type="text" id="username" placeholder="π.χ. Γιώργος" value="Μαθητής ${Math.floor(Math.random() * 100)}">
            </div>
            
            <div id="status" class="info">Έτοιμο για καταγραφή</div>
            
            <div class="controls">
                <button id="recordBtn">🎙️ Κάντε μια ερώτηση</button>
                <button id="stopBtn">⏹️ Σταματήστε την καταγραφή</button>
            </div>
            
            <div class="esp-status" style="margin-top: 20px;">
                <div class="status-dot" id="statusDot"></div>
                <span id="espConnected">Έλεγχος σύνδεσης...</span>
            </div>
        </div>
        
        <div class="container">
            <div id="conversation">
                <h3>💬 Συνομιλία</h3>
                <p style="color: #999; font-style: italic;">Οι ερωτήσεις όλων θα εμφανίζονται εδώ...</p>
            </div>
        </div>
        
        <script>
            let mediaRecorder;
            let audioBlob;
            
            const recordBtn = document.getElementById('recordBtn');
            const stopBtn = document.getElementById('stopBtn');
            const status = document.getElementById('status');
            const conversation = document.getElementById('conversation');
            const espConnected = document.getElementById('espConnected');
            const statusDot = document.getElementById('statusDot');
            const usernameInput = document.getElementById('username');
            
            recordBtn.onclick = startRecording;
            stopBtn.onclick = stopRecording;
            
            // Check ESP32 connection and queue status periodically
            setInterval(checkESPConnection, 3000);
            setInterval(updateQueueStatus, 2000);
            checkESPConnection();
            updateQueueStatus();
            
            async function startRecording() {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ 
                        audio: {
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true
                        } 
                    });
                    
                    mediaRecorder = new MediaRecorder(stream);
                    const audioChunks = [];
                    
                    mediaRecorder.ondataavailable = (event) => {
                        audioChunks.push(event.data);
                    };
                    
                    mediaRecorder.onstop = async () => {
                        audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
                        await processVoice();
                    };
                    
                    mediaRecorder.start();
                    
                    recordBtn.style.display = 'none';
                    stopBtn.style.display = 'inline-block';
                    updateStatus('🎤 Ακούω την ερώτηση σας...', 'info');
                    
                } catch (error) {
                    console.error('Error accessing microphone:', error);
                    updateStatus('❌ Σφάλμα πρόσβασης στο μικρόφωνο', 'error');
                }
            }
            
            function stopRecording() {
                if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                    mediaRecorder.stop();
                    recordBtn.style.display = 'inline-block';
                    stopBtn.style.display = 'none';
                    updateStatus('⏳ Επεξεργασία...', 'processing');
                }
            }
            
            async function processVoice() {
                if (!audioBlob) {
                    updateStatus('❌ Δεν υπάρχει καταγεγραμμένο audio!', 'error');
                    return;
                }
                
                const username = usernameInput.value.trim() || 'Χρήστης';
                
                updateStatus('🤖 Επεξεργασία με GPT-4o...', 'processing');
                recordBtn.disabled = true;
                
                const reader = new FileReader();
                reader.onloadend = async () => {
                    try {
                        const base64Audio = reader.result;
                        
                        const response = await fetch('/processVoice', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                audioData: base64Audio,
                                username: username
                            })
                        });
                        
                        const result = await response.json();
                        
                        if (response.ok) {
                            if (result.queuePosition === 0) {
                                updateStatus('✅ Η απάντηση παίζει ΤΩΡΑ στο ESP32!', 'success');
                            } else {
                                updateStatus(\`⏳ Προστέθηκε στην ουρά! Θέση: \${result.queuePosition}\`, 'info');
                            }
                            
                            addMessageToConversation(username, result.transcription, result.response);
                            updateQueueStatus();
                            
                        } else {
                            updateStatus('❌ Σφάλμα: ' + result.error, 'error');
                        }
                    } catch (error) {
                        console.error('Error processing voice:', error);
                        updateStatus('❌ Σφάλμα κατά την επεξεργασία', 'error');
                    } finally {
                        recordBtn.disabled = false;
                    }
                };
                
                reader.readAsDataURL(audioBlob);
            }
            
            function addMessageToConversation(username, question, answer) {
                const userDiv = document.createElement('div');
                userDiv.className = 'message user-message';
                userDiv.innerHTML = \`
                    <div class="message-user">\${username}</div>
                    <strong>Ερώτηση:</strong> \${question}
                \`;
                conversation.appendChild(userDiv);
                
                const assistantDiv = document.createElement('div');
                assistantDiv.className = 'message assistant-message';
                assistantDiv.innerHTML = \`
                    <div class="message-user">Assistant</div>
                    <strong>Απάντηση:</strong> \${answer}
                \`;
                conversation.appendChild(assistantDiv);
                
                conversation.scrollTop = conversation.scrollHeight;
            }
            
            async function updateQueueStatus() {
                try {
                    const response = await fetch('/queueStatus');
                    const data = await response.json();
                    
                    document.getElementById('queueLength').textContent = data.queueLength;
                    document.getElementById('isPlaying').textContent = data.isPlaying ? '▶️' : '⏸️';
                    
                    const currentlyPlayingDiv = document.getElementById('currentlyPlaying');
                    if (data.currentlyPlaying) {
                        currentlyPlayingDiv.style.display = 'block';
                        document.getElementById('playingUser').textContent = data.currentlyPlaying.username;
                        document.getElementById('playingQuestion').textContent = data.currentlyPlaying.transcription;
                    } else {
                        currentlyPlayingDiv.style.display = 'none';
                    }
                } catch (error) {
                    console.error('Error fetching queue status:', error);
                }
            }
            
            async function checkESPConnection() {
                try {
                    const response = await fetch('/ping');
                    if (response.ok) {
                        espConnected.textContent = 'ESP32 Συνδεδεμένο ✅';
                        statusDot.className = 'status-dot connected';
                    } else {
                        espConnected.textContent = 'ESP32 Αποσυνδεδεμένο ❌';
                        statusDot.className = 'status-dot disconnected';
                    }
                } catch (error) {
                    espConnected.textContent = 'ESP32 Αποσυνδεδεμένο ❌';
                    statusDot.className = 'status-dot disconnected';
                }
            }
            
            function updateStatus(message, type) {
                status.innerHTML = message;
                status.className = type;
            }
        </script>
    </body>
    </html>
    `);
});

// SERVER STARTUP

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`

 🎙️  Voice Assistant Server - Multi-User Queue System   


Server running on: http://localhost:${PORT}
OpenAI GPT: ${!!process.env.OPENAI_API_KEY ? '✅ Active' : '❌ Missing API Key'}
    `);
});

// ESP32 connection monitoring
setInterval(() => {
    if (!espConnected) {
        console.log('[ESP32] Not connected');
    } else {
        espConnected = false;
    }
}, 10000);