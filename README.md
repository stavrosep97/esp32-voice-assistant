ESP32-S3 Voice Assistant (Greek)

This is a voice assistant project using ESP32-S3, web interface and a Node.js backend that utilizes OpenAI APIs (Whisper, ChatGPT, TTS).
The assistant listens, sends audio to a server, gets a response from AI, and plays it back through a speaker. Designed specifically to support the Greek language.

🧠 How It Works
ESP32-S3 records voice through web interface using your computer.

The recorded .wav file is saved to SPIFFS filesystem.

Audio is streamed via HTTP to the Node.js server.

The server:

Saves audio locally.

Sends it to OpenAI Whisper (speech-to-text).

Passes the transcription to ChatGPT (language model).

Converts GPT response to audio using OpenAI TTS.

The final .mp3 is streamed back to the ESP32 and played through the MAX98357A speaker.

The ESP32 then goes into Deep Sleep to save power.


🖥️ Hardware Setup
Insert image here showing:

ESP32-S3

MAX98357A 

Small speaker 

Power connection

⚙️ Server Setup (Node.js)
Prerequisites
Node.js installed (v18 or newer recommended)

npm package manager

OpenAI API key

1. Clone the repo
git clone https://github.com/stavrosep97/esp32-voice-assistant.git
cd your-esp32-voice-assistant

2. Install dependencies
npm install

3. Create .env file
Create a .env file at the root with this content:

# OpenAI Configuration
OPENAI_API_KEY=sk-...

# Server Configuration  
PORT=3000
NODE_ENV=development

# Language Settings
WHISPER_LANGUAGE=el
CHATGPT_MODEL=gpt-3.5-turbo
TTS_VOICE=alloy


🧪 Test the System
Upload the ESP32 firmware via Arduino IDE or PlatformIO.

Run the Node.js server:
node server.js


Power the ESP32. It will:

Connect to WiFi

Start listening

Send voice to server

Get and play a response in Greek

✅ Notes
You must enable the OpenAI TTS API, Whisper API, and ChatGPT in your OpenAI account.