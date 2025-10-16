Voice Assistant Updates
Main Improvements
1. Upgrade to GPT-4o
The system now uses the GPT-4o model instead of GPT-3.5-turbo. This offers:

⦁	Better and more accurate responses
⦁	Improved understanding of the Greek language
⦁	Faster response times


2. Queue System for Multiple Users
In the previous version, only one user could use the system at a time. Now multiple users can ask questions simultaneously.
How it works:

⦁	Questions are placed in a waiting queue
⦁	Each answer plays in order on the ESP32
⦁	No user loses their answer

Technical implementation:

⦁	Created the AudioQueue class to manage requests
⦁	New /queueStatus endpoint for queue information
⦁	Web interface shows how many users are waiting and which question is playing

3. Enhanced Web Interface
New features:

⦁	Username field
⦁	Display of position in queue
⦁	Real-time ESP32 connection status with color indicator
⦁	Improved conversation layout

Installation
The ESP32 code remains the same. Only the server.js file needs to be replaced with servernew.js and the server restarted.
//node servernew.js