/**
 * @brief Voice Assistant – Client-side (ESP32-S3, Playback Only)
 * 
 * @author Stavros Epifaniou
 * @version 1.0
 * @date July 2025
 * 
 * Part of the final year thesis at Neapolis University Pafos.
 */

// Libraries
#include <SPIFFS.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <driver/i2s.h>

// RTOS Ticks Delay
#define TickDelay(ms) vTaskDelay(pdMS_TO_TICKS(ms))

// MAX98357A Ports
#define I2S_DOUT 15   // Data out pin (DIN)
#define I2S_BCLK 16   // Bit clock pin 
#define I2S_LRC 17    // Left/Right clock pin

// Button & LEDs
#define BUTTON_PIN 5
#define WIFI_LED_PIN 6
#define PLAY_LED_PIN 4

// MAX98357A I2S Setup
#define MAX_I2S_NUM I2S_NUM_0
#define MAX_I2S_SAMPLE_RATE (16000)
#define MAX_I2S_SAMPLE_BITS (16)
#define MAX_I2S_READ_LEN (512)  // smaller buffer size

// WiFi settings
const char* ssid = "your network name";
const char* password = "your network password";

// Server Connection / here you need to change to your wlan ip adress
const char* serverBroadcastUrl = "http://172.20.10.2:3000/broadcastAudio";//change with your ip adress
const char* broadcastPermitionUrl = "http://172.20.10.2:3000/checkVariable";//change with your ip adress
const char* pingUrl = "http://172.20.10.2:3000/ping";//change with your ip adress

bool isWIFIConnected = false;
bool isAudioPlaying = false;
TaskHandle_t audioTaskHandle = NULL;

// Prototypes
void SPIFFSInit();
void i2sInitMax98357A();
void wifiConnect(void *pvParameters);
void checkForAudio(void *arg);
void playAudio(void *arg);
void buttonHandler(void *arg);

void setup() {
  Serial.begin(115200);
  TickDelay(500);
  Serial.println("\n\n=== Voice Assistant ESP32-S3 Client ===");
  
  // Initialize LED pins
  pinMode(WIFI_LED_PIN, OUTPUT);
  pinMode(PLAY_LED_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT);  
  
  digitalWrite(WIFI_LED_PIN, LOW);
  digitalWrite(PLAY_LED_PIN, LOW);
  
  // Initialize SPIFFS
  SPIFFSInit();
  
  // Create WiFi connection task
  xTaskCreate(wifiConnect, "wifi_Connect", 4096, NULL, 2, NULL);
  TickDelay(500);
  
  // Create task to check if audio is available
  xTaskCreate(checkForAudio, "checkForAudio", 4096, NULL, 1, NULL);
  TickDelay(500);
  
  // Create task to handle button press
  xTaskCreate(buttonHandler, "buttonHandler", 2048, NULL, 1, NULL);
  
  Serial.println("Setup complete!");
}

void loop() {
  // Nothing to do here, everything is handled by tasks
  delay(1000);
}

void SPIFFSInit() {
  if (!SPIFFS.begin(true)) {
    Serial.println("SPIFFS initialization failed!");
    while (1) yield();
  }
  Serial.println("SPIFFS initialized successfully");
}

void wifiConnect(void *pvParameters) {
  isWIFIConnected = false;
  
  Serial.printf("Connecting to WiFi network: %s\n", ssid);
  WiFi.begin(ssid, password);
  
  while (WiFi.status() != WL_CONNECTED) {
    digitalWrite(WIFI_LED_PIN, LOW);
    vTaskDelay(500);
    digitalWrite(WIFI_LED_PIN, HIGH);
    vTaskDelay(500);
    Serial.print(".");
  }
  
  isWIFIConnected = true;
  digitalWrite(WIFI_LED_PIN, HIGH);
  Serial.println("\nWiFi connected!");
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());
  
  while (true) {
    // Keep checking WiFi connection
    if (WiFi.status() != WL_CONNECTED) {
      isWIFIConnected = false;
      digitalWrite(WIFI_LED_PIN, LOW);
      
      Serial.println("WiFi connection lost, reconnecting...");
      WiFi.reconnect();
      
      while (WiFi.status() != WL_CONNECTED) {
        digitalWrite(WIFI_LED_PIN, LOW);
        vTaskDelay(500);
        digitalWrite(WIFI_LED_PIN, HIGH);
        vTaskDelay(500);
        Serial.print(".");
      }
      
      isWIFIConnected = true;
      digitalWrite(WIFI_LED_PIN, HIGH);
      Serial.println("\nWiFi reconnected!");
    }
    
    // Ping the server every 5 seconds to let it know we're online
    HTTPClient http;
    http.begin(pingUrl);
    int httpCode = http.GET();
    if (httpCode == HTTP_CODE_OK) {
      Serial.println("Server ping successful");
    } else {
      Serial.printf("Server ping failed, error: %s\n", http.errorToString(httpCode).c_str());
    }
    http.end();
    
    vTaskDelay(5000);
  }
}

void checkForAudio(void *arg) {
  HTTPClient http;
  
  while (true) {
    if (isWIFIConnected && !isAudioPlaying) {
      http.begin(broadcastPermitionUrl);
      int httpResponseCode = http.GET();
      
      if (httpResponseCode > 0) {
        String payload = http.getString();
        
        if (payload.indexOf("\"ready\":true") > -1) {
          Serial.println("Audio is ready on server! Starting playback...");
          
          // Create audio playback task if not already running
          if (audioTaskHandle == NULL) {
            xTaskCreate(playAudio, "playAudio", 16384, NULL, 3, &audioTaskHandle);
          }
        }
      } else {
        Serial.print("HTTP request failed with error code: ");
        Serial.println(httpResponseCode);
      }
      
      http.end();
    }
    
    // Check every 1 second
    vTaskDelay(1000);
  }
}

void buttonHandler(void *arg) {
  bool lastButtonState = false;
  bool buttonState = false;
  
  while (true) {
    buttonState = digitalRead(BUTTON_PIN);
    
    // Button pressed (rising edge)
    if (buttonState == HIGH && lastButtonState == LOW) {
      Serial.println("Button pressed!");
      
      // Flash the LED to indicate button press
      for (int i = 0; i < 3; i++) {
        digitalWrite(PLAY_LED_PIN, HIGH);
        vTaskDelay(100);
        digitalWrite(PLAY_LED_PIN, LOW);
        vTaskDelay(100);
      }
    }
    
    lastButtonState = buttonState;
    vTaskDelay(100);  // Check button every 100ms
  }
}

void playAudio(void *arg) {
  isAudioPlaying = true;
  digitalWrite(PLAY_LED_PIN, HIGH);
  
  // Initialize I2S for audio playback
  i2sInitMax98357A();
  
  HTTPClient http;
  http.begin(serverBroadcastUrl);
  
  int httpCode = http.GET();
  if (httpCode == HTTP_CODE_OK) {
    WiFiClient *stream = http.getStreamPtr();
    
    // Smaller buffer for better memory management
    uint8_t buffer[MAX_I2S_READ_LEN];
    size_t total_bytes = 0;
    
    Serial.println("Starting audio playback...");
    
    while (stream->connected()) {
      // Read smaller chunks of data
      size_t available_bytes = stream->available();
      
      if (available_bytes > 0) {
        // We limit the size we read each time
        size_t bytes_to_read = (available_bytes > MAX_I2S_READ_LEN) ? MAX_I2S_READ_LEN : available_bytes;
        
        int len = stream->read(buffer, bytes_to_read);
        if (len > 0) {
          // Reduce the volume
// For 16-bit PCM, each sample consists of 2 bytes
          if (MAX_I2S_SAMPLE_BITS == 16) {
            for (int i = 0; i < len; i += 2) {
              int16_t* sample = (int16_t*)&buffer[i];
              // Reduce the intensity to 30%
              *sample = (*sample * 30) / 100;
            }
          }
          
          size_t bytes_written;
          esp_err_t result = i2s_write(MAX_I2S_NUM, buffer, len, &bytes_written, 10);
          
          if (result != ESP_OK) {
            Serial.printf("Error in I2S write: %d\n", result);
            break;
          }
          
          total_bytes += bytes_written;
          
          // We give time to watchdog
          delay(1);
        } else {
          // if no more data available
          break;
        }
      } else if (!stream->available() && !stream->connected()) {
        // End of flow control
        break;
      } else {
        // If no data is available, we wait a while
        delay(10);
      }
    }
    
    Serial.printf("Total bytes played: %d\n", total_bytes);
    Serial.println("Audio playback completed");
  } else {
    Serial.printf("HTTP GET failed, error: %s\n", http.errorToString(httpCode).c_str());
  }
  
  http.end();
  
  // Cleanup after playback
  i2s_driver_uninstall(MAX_I2S_NUM);
  digitalWrite(PLAY_LED_PIN, LOW);
  isAudioPlaying = false;
  audioTaskHandle = NULL;
  
  vTaskDelete(NULL);
}

void i2sInitMax98357A() {
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate = MAX_I2S_SAMPLE_RATE,
    .bits_per_sample = i2s_bits_per_sample_t(MAX_I2S_SAMPLE_BITS),
    .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 8,
    .dma_buf_len = 64,
    .use_apll = false,
    .tx_desc_auto_clear = true,
    .fixed_mclk = 0
  };
  
  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_BCLK,
    .ws_io_num = I2S_LRC,
    .data_out_num = I2S_DOUT,
    .data_in_num = I2S_PIN_NO_CHANGE
  };
  
  esp_err_t result = i2s_driver_install(MAX_I2S_NUM, &i2s_config, 0, NULL);
  if (result != ESP_OK) {
    Serial.printf("Error installing I2S driver: %d\n", result);
    return;
  }
  
  result = i2s_set_pin(MAX_I2S_NUM, &pin_config);
  if (result != ESP_OK) {
    Serial.printf("Error setting I2S pins: %d\n", result);
    i2s_driver_uninstall(MAX_I2S_NUM);
    return;
  }
  
  i2s_zero_dma_buffer(MAX_I2S_NUM);
}