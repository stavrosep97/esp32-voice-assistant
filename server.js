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

// Server state
let audioBuffer = Buffer.alloc(0);
let isAudioReady = false;
let espConnected = false;
let currentProcessing = false;

// ESP ping endpoint
app.get('/ping', (req, res) => {
    espConnected = true;
    res.json({ status: 'pong' });
});

// Endpoint to check if the audio was ready
app.get('/checkVariable', (req, res) => {
    res.json({ ready: isAudioReady });
});

// Endpoint to send audio to ESP32
app.get('/broadcastAudio', (req, res) => {
    if (!isAudioReady || audioBuffer.length === 0) {
        return res.status(404).json({ error: 'No audio available' });
    }
    
    console.log('Broadcasting audio to ESP32...');
    res.set('Content-Type', 'audio/wav');
    res.send(audioBuffer);
    
    // after send completed, cleaning the buffer
    audioBuffer = Buffer.alloc(0);
    isAudioReady = false;
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

// Function to get response from ChatGPT
async function getChatGPTResponse(text) {
    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-3.5-turbo',
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

// Main endpoint for processing voice
app.post('/processVoice', async (req, res) => {
    if (currentProcessing) {
        return res.status(429).json({ error: 'Ήδη επεξεργάζεται μια άλλη αίτηση' });
    }

    if (!req.body.audioData) {
        return res.status(400).json({ error: 'No audio data provided' });
    }

    currentProcessing = true;

    try {
        console.log('Starting voice processing...');
        
        // Convert base64 to buffer
        const base64Data = req.body.audioData.replace(/^data:audio\/wav;base64,/, '');
        const audioBlob = Buffer.from(base64Data, 'base64');
        
        // Step 1: Convert speech to text
        console.log('Converting speech to text...');
        const transcription = await speechToText(audioBlob);
        console.log('Transcription:', transcription);
        
        if (!transcription.trim()) {
            throw new Error('Δεν κατέστη δυνατή η αναγνώριση φωνής');
        }
        
        // Step 2: Get response from ChatGPT
        console.log('Getting ChatGPT response...');
        const chatResponse = await getChatGPTResponse(transcription);
        console.log('ChatGPT response:', chatResponse);
        
        // Step 3: Convert response to speech
        console.log('Converting response to speech...');
        const speechAudio = await textToSpeech(chatResponse);
        
        // Save audio for ESP32
        audioBuffer = speechAudio;
        isAudioReady = true;
        
        res.json({
            success: true,
            transcription: transcription,
            response: chatResponse,
            message: 'Η απάντηση είναι έτοιμη για το ESP32'
        });
        
    } catch (error) {
        console.error('Voice processing error:', error);
        res.status(500).json({ 
            error: 'Σφάλμα κατά την επεξεργασία', 
            details: error.message 
        });
    } finally {
        currentProcessing = false;
    }
});

// Web interface
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Voice Assistant - OpenAI Integration</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body {
                font-family: Arial, sans-serif;
                max-width: 600px;
                margin: 0 auto;
                padding: 20px;
                text-align: center;
                background-color: #f0f2f5;
            }
            
            .container {
                background: white;
                padding: 30px;
                border-radius: 10px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            
            button {
                padding: 15px 30px;
                font-size: 18px;
                margin: 10px;
                border: none;
                border-radius: 5px;
                cursor: pointer;
                transition: background-color 0.3s;
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
            
            button:hover {
                opacity: 0.8;
            }
            
            button:disabled {
                background-color: #cccccc;
                cursor: not-allowed;
                opacity: 1;
            }
            
            #status {
                margin-top: 20px;
                padding: 10px;
                border-radius: 5px;
                margin-bottom: 20px;
                min-height: 50px;
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
            
            #conversation {
                margin-top: 30px;
                text-align: left;
                max-height: 300px;
                overflow-y: auto;
                border: 1px solid #ddd;
                padding: 15px;
                border-radius: 5px;
            }
            
            .message {
                margin: 10px 0;
                padding: 10px;
                border-radius: 5px;
            }
            
            .user-message {
                background-color: #e3f2fd;
                margin-left: 20px;
            }
            
            .assistant-message {
                background-color: #f5f5f5;
                margin-right: 20px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>Voice Assistant</h1>
            <p>Πατήστε το κουμπί για να κάνετε μια ερώτηση</p>
            
            <div id="status" class="info">Έτοιμο για καταγραφή</div>
            
            <button id="recordBtn">🎙️ Κάντε μια ερώτηση</button>
            <button id="stopBtn">⏹️ Σταματήστε την καταγραφή</button>
            
            <div id="espStatus" style="margin-top: 20px; padding: 10px; border-radius: 5px;">
                <p>ESP32 Status: <span id="espConnected">Έλεγχος...</span></p>
            </div>
            
            <div id="conversation">
                <h3>Συνομιλία</h3>
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
            
            recordBtn.onclick = startRecording;
            stopBtn.onclick = stopRecording;
            
            // Check ESP32 connection periodically
            setInterval(checkESPConnection, 5000);
            checkESPConnection();
            
            async function startRecording() {
                try {
                    // Request microphone access
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
                    
                    // Update UI
                    recordBtn.style.display = 'none';
                    stopBtn.style.display = 'inline-block';
                    updateStatus('Ακούω την ερώτηση σας...', 'info');
                    
                } catch (error) {
                    console.error('Error accessing microphone:', error);
                    updateStatus('Σφάλμα πρόσβασης στο μικρόφωνο. Παρακαλώ επιτρέψτε την πρόσβαση.', 'error');
                }
            }
            
            function stopRecording() {
                if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                    mediaRecorder.stop();
                    
                    // Update UI
                    recordBtn.style.display = 'inline-block';
                    stopBtn.style.display = 'none';
                    updateStatus('Επεξεργασία...', 'processing');
                }
            }
            
            async function processVoice() {
                if (!audioBlob) {
                    updateStatus('Δεν υπάρχει καταγεγραμμένο audio!', 'error');
                    return;
                }
                
                updateStatus('Επεξεργασία με OpenAI...', 'processing');
                recordBtn.disabled = true;
                
                // Convert to base64
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
                                audioData: base64Audio
                            })
                        });
                        
                        const result = await response.json();
                        
                        if (response.ok) {
                            updateStatus('Η απάντηση στάλθηκε στο ESP32! Η απάντηση θα ακουστεί σύντομα.', 'success');
                            
                            // Add to conversation
                            addMessageToConversation('user', result.transcription);
                            addMessageToConversation('assistant', result.response);
                            
                        } else {
                            updateStatus('Σφάλμα: ' + result.error, 'error');
                        }
                    } catch (error) {
                        console.error('Error processing voice:', error);
                        updateStatus('Σφάλμα κατά την επεξεργασία της φωνής', 'error');
                    } finally {
                        recordBtn.disabled = false;
                    }
                };
                
                reader.readAsDataURL(audioBlob);
            }
            
            function addMessageToConversation(type, message) {
                const messageDiv = document.createElement('div');
                messageDiv.className = 'message ' + (type === 'user' ? 'user-message' : 'assistant-message');
                messageDiv.innerHTML = '<strong>' + (type === 'user' ? 'Εσείς:' : 'Assistant:') + '</strong> ' + message;
                conversation.appendChild(messageDiv);
                
                // Scroll to bottom
                conversation.scrollTop = conversation.scrollHeight;
            }
            
            async function checkESPConnection() {
                try {
                    const response = await fetch('/ping');
                    if (response.ok) {
                        espConnected.textContent = 'Συνδεδεμένο ✅';
                        espConnected.style.color = 'green';
                    } else {
                        espConnected.textContent = 'Αποσυνδεδεμένο ❌';
                        espConnected.style.color = 'red';
                    }
                } catch (error) {
                    espConnected.textContent = 'Αποσυνδεδεμένο ❌';
                    espConnected.style.color = 'red';
                }
            }
            
            function updateStatus(message, type) {
                status.textContent = message;
                status.className = type;
            }
        </script>
    </body>
    </html>
    `);
});

// Server startup
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Voice Assistant Server running on http://localhost:${PORT}`);
    console.log('Make sure your ESP32 can access this server');
    console.log('OpenAI API Key loaded:', !!process.env.OPENAI_API_KEY);
});

// ESP32 connection monitoring
setInterval(() => {
    if (!espConnected) {
        console.log('ESP32 not connected');
    } else {
        espConnected = false; // Reset for next verification
    }
}, 10000);