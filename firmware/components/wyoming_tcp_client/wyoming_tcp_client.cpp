#include "wyoming_tcp_client.h"
#include "esphome/core/log.h"

#include <lwip/sockets.h>
#include <lwip/netdb.h>
#include <errno.h>

namespace esphome {
namespace wyoming_tcp_client {

static const char *const TAG = "wyoming_tcp";

// ─── Component lifecycle ─────────────────────────────────────────────────────

void WyomingTcpClient::setup() {
  ESP_LOGI(TAG, "Setting up Wyoming TCP client -> %s:%d",
           this->host_.c_str(), this->port_);

  this->mic_buffer_ = RingBuffer::create(16384);  // ~500ms at 16kHz 16-bit
  this->spk_buffer_ = RingBuffer::create(256000);  // ~8s response buffer at 16kHz

  // Register microphone callback
  this->mic_source_->add_data_callback(
      [this](const std::vector<uint8_t> &data) {
        if (this->state_ == State::STREAMING) {
          this->mic_buffer_->write((void *) data.data(), data.size());
        }
      });

  ESP_LOGI(TAG, "Ready, waiting for wake word");
}

// Pre-buffer threshold: 100ms of 16kHz mono 16-bit = 3200 bytes
// RealtimeClaw now paces audio delivery at 32ms/chunk, so less buffering needed
static const size_t PRE_BUFFER_BYTES = 3200;

void WyomingTcpClient::loop() {
  // Speaker is driven by spk_task_, not loop()
  // Just handle speaker lifecycle
  if (this->speaker_started_ && this->state_ == State::IDLE &&
      this->spk_buffer_->available() == 0) {
    if (this->speaker_->is_stopped()) {
      this->speaker_started_ = false;
      ESP_LOGI(TAG, "Speaker finished");
    } else if (!this->speaker_stopping_) {
      this->speaker_->stop();
      this->speaker_stopping_ = true;
      ESP_LOGI(TAG, "Speaker stop requested");
    }
  }
}

void WyomingTcpClient::spk_task_(void *param) {
  auto *self = static_cast<WyomingTcpClient *>(param);
  self->spk_task_loop_();
  vTaskDelete(nullptr);
}

void WyomingTcpClient::spk_task_loop_() {
  // Wait for pre-buffer threshold
  ESP_LOGI(TAG, "Speaker task: waiting for %zu bytes pre-buffer", PRE_BUFFER_BYTES);
  while (this->spk_buffer_->available() < PRE_BUFFER_BYTES) {
    if (this->audio_done_ || this->state_ == State::ERROR ||
        this->state_ == State::IDLE) {
      // Audio ended before we got enough to pre-buffer — play what we have
      if (this->spk_buffer_->available() > 0) break;
      ESP_LOGI(TAG, "Speaker task: session ended before pre-buffer filled");
      this->spk_task_handle_ = nullptr;
      return;
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }

  // Start speaker — 16kHz mono 16-bit, resampler handles conversion to 48kHz
  audio::AudioStreamInfo stream_info(16, 1, 16000);
  this->speaker_->set_audio_stream_info(stream_info);
  this->speaker_->start();
  this->speaker_started_ = true;
  ESP_LOGI(TAG, "Speaker task: started after pre-buffering");

  // Continuously feed speaker from ring buffer
  // 16kHz mono 16-bit PCM → announcement_resampling_speaker handles 48kHz conversion
  uint8_t buf[1024];

  while (true) {
    size_t available = this->spk_buffer_->available();

    if (available >= sizeof(buf)) {
      this->spk_buffer_->read((void *) buf, sizeof(buf), 0);
      this->speaker_->play(buf, sizeof(buf), pdMS_TO_TICKS(10));
    } else if (available > 0 && this->audio_done_) {
      this->spk_buffer_->read((void *) buf, available, 0);
      this->speaker_->play(buf, available, pdMS_TO_TICKS(10));
    } else if (this->audio_done_ && available == 0) {
      break;
    } else {
      vTaskDelay(pdMS_TO_TICKS(5));
    }
  }

  ESP_LOGI(TAG, "Speaker task: playback complete");
  this->spk_task_handle_ = nullptr;  // Signal net_task we're done
}

void WyomingTcpClient::start() {
  // Allow restart from IDLE or ERROR. ERROR is treated as recoverable so a
  // transient network failure (e.g. server restart) doesn't require a power
  // cycle — the next wake word simply opens a fresh session.
  if (this->state_ != State::IDLE && this->state_ != State::ERROR) {
    ESP_LOGW(TAG, "Already active (state=%d), ignoring start",
             static_cast<int>(this->state_.load()));
    return;
  }

  if (this->state_ == State::ERROR) {
    ESP_LOGI(TAG, "Recovering from ERROR state");
    this->disconnect_();
  }

  ESP_LOGI(TAG, "Starting session");
  this->state_ = State::CONNECTING;
  this->speaker_stopping_ = false;

  // Launch network task on Core 1
  xTaskCreatePinnedToCore(WyomingTcpClient::net_task_, "wyoming_net",
                          8192, this, 5, &this->net_task_handle_, 1);
}

void WyomingTcpClient::stop() {
  ESP_LOGI(TAG, "Stopping session");
  this->state_ = State::IDLE;
  this->disconnect_();
}

// ─── Task 2: TCP connection + Wyoming protocol framing ───────────────────────

bool WyomingTcpClient::connect_() {
  int sock = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (sock < 0) {
    ESP_LOGE(TAG, "socket() failed: errno %d", errno);
    return false;
  }

  struct sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(this->port_);
  if (::inet_pton(AF_INET, this->host_.c_str(), &addr.sin_addr) != 1) {
    ESP_LOGE(TAG, "inet_pton() failed for host '%s'", this->host_.c_str());
    ::close(sock);
    return false;
  }

  if (::connect(sock, reinterpret_cast<struct sockaddr *>(&addr),
                sizeof(addr)) != 0) {
    ESP_LOGE(TAG, "connect() to %s:%d failed: errno %d",
             this->host_.c_str(), this->port_, errno);
    ::close(sock);
    return false;
  }

  // Disable Nagle algorithm for low latency
  int flag = 1;
  ::setsockopt(sock, IPPROTO_TCP, TCP_NODELAY,
               reinterpret_cast<const void *>(&flag), sizeof(flag));

  this->sock_ = sock;
  ESP_LOGI(TAG, "Connected to %s:%d", this->host_.c_str(), this->port_);
  return true;
}

void WyomingTcpClient::disconnect_() {
  if (this->sock_ >= 0) {
    ::close(this->sock_);
    this->sock_ = -1;
    ESP_LOGI(TAG, "Disconnected");
  }
}

bool WyomingTcpClient::send_event_(const char *type, const char *data_json,
                                    const uint8_t *payload,
                                    size_t payload_len) {
  if (this->sock_ < 0) {
    return false;  // Socket already closed — avoid send on -1
  }

  char header[256];
  int header_len;

  size_t data_len = (data_json != nullptr) ? strlen(data_json) : 0;

  if (data_json != nullptr && payload_len > 0) {
    header_len = snprintf(header, sizeof(header),
        "{\"type\":\"%s\",\"version\":\"1.7.2\","
        "\"data_length\":%zu,\"payload_length\":%zu}\n",
        type, data_len, payload_len);
  } else if (data_json != nullptr) {
    header_len = snprintf(header, sizeof(header),
        "{\"type\":\"%s\",\"version\":\"1.7.2\","
        "\"data_length\":%zu}\n",
        type, data_len);
  } else if (payload_len > 0) {
    header_len = snprintf(header, sizeof(header),
        "{\"type\":\"%s\",\"version\":\"1.7.2\","
        "\"payload_length\":%zu}\n",
        type, payload_len);
  } else {
    header_len = snprintf(header, sizeof(header),
        "{\"type\":\"%s\",\"version\":\"1.7.2\"}\n",
        type);
  }

  if (::send(this->sock_, header, header_len, MSG_DONTWAIT) < 0) {
    ESP_LOGE(TAG, "send() header failed: errno %d", errno);
    return false;
  }

  if (data_json != nullptr && data_len > 0) {
    if (::send(this->sock_, data_json, data_len, MSG_DONTWAIT) < 0) {
      ESP_LOGE(TAG, "send() data_json failed: errno %d", errno);
      return false;
    }
  }

  if (payload != nullptr && payload_len > 0) {
    size_t sent = 0;
    while (sent < payload_len) {
      ssize_t n = ::send(this->sock_, payload + sent, payload_len - sent,
                         MSG_DONTWAIT);
      if (n < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
          vTaskDelay(pdMS_TO_TICKS(1));
          continue;
        }
        ESP_LOGE(TAG, "send() payload failed: errno %d", errno);
        return false;
      }
      sent += static_cast<size_t>(n);
    }
  }

  return true;
}

void WyomingTcpClient::send_audio_start_() {
  this->send_event_("audio-start",
                    "{\"rate\":16000,\"width\":2,\"channels\":1}");
}

void WyomingTcpClient::send_audio_stop_() {
  this->send_event_("audio-stop", "{\"timestamp\":null}");
}

// ─── Task 3: Network task (send + receive loop) ──────────────────────────────

void WyomingTcpClient::net_task_(void *param) {
  WyomingTcpClient *self = static_cast<WyomingTcpClient *>(param);
  self->net_task_loop_();
  vTaskDelete(nullptr);
}

void WyomingTcpClient::net_task_loop_() {
  // Phase 1: Connect. A failure here must still return the component to IDLE
  // so the next wake word can try again — otherwise a single missed connect
  // (e.g. server not yet up at boot) would jam the client until reboot.
  if (!this->connect_()) {
    ESP_LOGE(TAG, "Connection failed, returning to IDLE");
    this->state_ = State::IDLE;
    this->net_task_handle_ = nullptr;
    return;
  }

  // Phase 2: Start mic, transition to STREAMING
  this->mic_source_->start();
  this->state_ = State::STREAMING;
  this->send_audio_start_();
  ESP_LOGI(TAG, "Streaming audio to %s:%d", this->host_.c_str(), this->port_);

  static uint8_t chunk[1024];

  this->audio_done_ = false;
  this->last_activity_ms_ = millis();

  // Phase 3: Main loop — stays open for multi-turn conversation
  while (this->state_ != State::IDLE &&
         this->state_ != State::ERROR) {

    if (this->state_ == State::STREAMING) {
      // Drain mic_buffer_ in 1024-byte chunks
      while (this->mic_buffer_->available() >= sizeof(chunk)) {
        this->mic_buffer_->read((void *) chunk, sizeof(chunk), 0);
        if (!this->send_event_("audio-chunk",
                          "{\"rate\":16000,\"width\":2,\"channels\":1}",
                          chunk, sizeof(chunk))) {
          ESP_LOGE(TAG, "Failed to send audio chunk, connection lost");
          this->state_ = State::ERROR;
          break;
        }
      }
    }

    // Idle timeout applies in every active state. Without this, a server
    // that drops the TCP connection during RECEIVING would trap us in the
    // loop forever (no sends happen in RECEIVING, so send errors never fire).
    if (millis() - this->last_activity_ms_ > SESSION_TIMEOUT_MS) {
      ESP_LOGI(TAG, "Session idle for %lums, closing", SESSION_TIMEOUT_MS);
      break;
    }

    // After response audio finishes, resume streaming mic audio
    if (this->audio_done_) {
      this->audio_done_ = false;
      this->state_ = State::STREAMING;
      this->last_activity_ms_ = millis();  // Reset timeout after response
      ESP_LOGI(TAG, "Response done, resuming mic streaming for next turn");
    }

    // Peer-close detection: receive_events_ returns false when recv reads
    // 0 bytes (peer FIN) or a real socket error — treat as connection lost.
    if (!this->receive_events_()) {
      ESP_LOGW(TAG, "Receive failed, connection lost");
      this->state_ = State::ERROR;
      break;
    }
    vTaskDelay(pdMS_TO_TICKS(10));
  }

  // Phase 4: Cleanup — always ends with state_ = IDLE so the next wake word
  // can open a fresh session, even after a network error.
  if (this->sock_ >= 0) {
    this->send_audio_stop_();  // best-effort; no-op if socket already gone
  }
  this->disconnect_();
  this->mic_source_->stop();

  // Wait for speaker task to finish draining audio
  if (this->spk_task_handle_ != nullptr) {
    ESP_LOGI(TAG, "Waiting for speaker to finish...");
    // spk_task_ checks state_ == IDLE and spk_buffer empty, then exits
    int timeout = 500;  // 5 seconds max
    while (this->spk_task_handle_ != nullptr && timeout-- > 0) {
      vTaskDelay(pdMS_TO_TICKS(10));
    }
    if (timeout <= 0) {
      ESP_LOGW(TAG, "Speaker task did not finish in time");
    }
  }

  this->state_ = State::IDLE;
  this->net_task_handle_ = nullptr;
  ESP_LOGI(TAG, "Session ended");
}

bool WyomingTcpClient::receive_events_() {
  // Non-blocking check: select with 1ms timeout
  fd_set read_fds;
  FD_ZERO(&read_fds);
  FD_SET(this->sock_, &read_fds);
  struct timeval tv{0, 1000};  // 1ms

  int ready = ::select(this->sock_ + 1, &read_fds, nullptr, nullptr, &tv);
  if (ready <= 0) {
    // 0 = timeout, -1 with EAGAIN/EWOULDBLOCK is benign
    return true;
  }

  // Read header line (terminated by '\n')
  std::string header_line;
  header_line.reserve(256);
  char c;
  while (true) {
    ssize_t n = ::recv(this->sock_, &c, 1, 0);
    if (n <= 0) {
      if (n == 0) {
        ESP_LOGW(TAG, "Server closed connection during header read");
      } else if (errno != EAGAIN && errno != EWOULDBLOCK) {
        ESP_LOGE(TAG, "recv() header byte failed: errno %d", errno);
      }
      return false;
    }
    if (c == '\n') break;
    header_line += c;
  }

  // Parse "type" value
  std::string type;
  {
    size_t pos = header_line.find("\"type\"");
    if (pos == std::string::npos) {
      ESP_LOGW(TAG, "No 'type' in header: %s", header_line.c_str());
      return true;
    }
    pos = header_line.find('"', pos + 6);   // opening quote of value
    if (pos == std::string::npos) return true;
    size_t end = header_line.find('"', pos + 1);
    if (end == std::string::npos) return true;
    type = header_line.substr(pos + 1, end - pos - 1);
  }

  // Parse "data_length"
  size_t data_length = 0;
  {
    size_t pos = header_line.find("\"data_length\"");
    if (pos != std::string::npos) {
      pos = header_line.find(':', pos + 13);
      if (pos != std::string::npos) {
        data_length = static_cast<size_t>(atoi(header_line.c_str() + pos + 1));
      }
    }
  }

  // Parse "payload_length"
  size_t payload_length = 0;
  {
    size_t pos = header_line.find("\"payload_length\"");
    if (pos != std::string::npos) {
      pos = header_line.find(':', pos + 16);
      if (pos != std::string::npos) {
        payload_length = static_cast<size_t>(
            atoi(header_line.c_str() + pos + 1));
      }
    }
  }

  // Read data bytes (blocking)
  std::string data_json;
  if (data_length > 0) {
    data_json.resize(data_length);
    size_t received = 0;
    while (received < data_length) {
      ssize_t n = ::recv(this->sock_,
                         &data_json[received],
                         data_length - received, 0);
      if (n <= 0) {
        if (n == 0) {
          ESP_LOGW(TAG, "Server closed connection during data read");
        } else {
          ESP_LOGE(TAG, "recv() data failed: errno %d", errno);
        }
        return false;
      }
      received += static_cast<size_t>(n);
    }
  }

  // Read payload bytes (blocking)
  std::vector<uint8_t> payload;
  if (payload_length > 0) {
    payload.resize(payload_length);
    size_t received = 0;
    while (received < payload_length) {
      ssize_t n = ::recv(this->sock_,
                         payload.data() + received,
                         payload_length - received, 0);
      if (n <= 0) {
        if (n == 0) {
          ESP_LOGW(TAG, "Server closed connection during payload read");
        } else {
          ESP_LOGE(TAG, "recv() payload failed: errno %d", errno);
        }
        return false;
      }
      received += static_cast<size_t>(n);
    }
  }

  this->handle_received_event_(type, data_json, payload);
  this->last_activity_ms_ = millis();  // Any inbound byte resets idle timer
  return true;
}

void WyomingTcpClient::handle_received_event_(const std::string &type,
                                               const std::string &data_json,
                                               const std::vector<uint8_t> &payload) {
  if (type == "audio-start") {
    ESP_LOGI(TAG, "Received audio-start, switching to RECEIVING");
    this->state_ = State::RECEIVING;
    this->last_activity_ms_ = millis();
    // Launch speaker task to handle playback from spk_buffer_
    if (this->spk_task_handle_ == nullptr) {
      xTaskCreatePinnedToCore(WyomingTcpClient::spk_task_, "wyoming_spk",
                              8192, this, 10, &this->spk_task_handle_, 0);
    }

  } else if (type == "audio-chunk") {
    if (!payload.empty()) {
      size_t free = this->spk_buffer_->free();
      if (free >= payload.size()) {
        this->spk_buffer_->write(
            const_cast<void *>(reinterpret_cast<const void *>(payload.data())),
            payload.size());
      } else {
        ESP_LOGW(TAG, "Speaker buffer full, dropping %zu bytes", payload.size());
      }
    }

  } else if (type == "audio-stop") {
    ESP_LOGI(TAG, "Received audio-stop");
    this->audio_done_ = true;

  } else if (type == "transcript") {
    ESP_LOGI(TAG, "Transcript: %s", data_json.c_str());

  } else {
    ESP_LOGW(TAG, "Unhandled event type: %s", type.c_str());
  }
}

}  // namespace wyoming_tcp_client
}  // namespace esphome
