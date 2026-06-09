#pragma once

#include "esphome/core/automation.h"
#include "esphome/core/component.h"
#include "esphome/components/microphone/microphone_source.h"
#include "esphome/components/speaker/speaker.h"
#include "esphome/components/audio/audio.h"
#include "esphome/core/ring_buffer.h"

#include <lwip/sockets.h>
#include <string>
#include <vector>
#include <atomic>

namespace esphome {
namespace wyoming_tcp_client {

enum class State : uint8_t {
  IDLE,
  CONNECTING,
  STREAMING,
  RECEIVING,
  ERROR,
};

class WyomingTcpClient : public Component {
 public:
  void setup() override;
  void loop() override;
  float get_setup_priority() const override {
    return setup_priority::AFTER_WIFI;
  }

  void set_host(const std::string &host) { this->host_ = host; }
  void set_port(uint16_t port) { this->port_ = port; }
  void set_microphone_source(microphone::MicrophoneSource *mic) {
    this->mic_source_ = mic;
  }
  void set_speaker(speaker::Speaker *spk) { this->speaker_ = spk; }

  /// Called from YAML automation on wake word detection
  void start();
  /// Stop current session
  void stop();

 protected:
  std::string host_;
  uint16_t port_{10300};
  microphone::MicrophoneSource *mic_source_{nullptr};
  speaker::Speaker *speaker_{nullptr};

  std::atomic<State> state_{State::IDLE};
  int sock_{-1};

  // Ring buffers for inter-task communication
  std::shared_ptr<RingBuffer> mic_buffer_;
  std::shared_ptr<RingBuffer> spk_buffer_;

  bool speaker_started_{false};
  bool speaker_stopping_{false};
  std::atomic<bool> audio_done_{false};
  uint32_t last_activity_ms_{0};  // millis() of last speech/response
  static const uint32_t SESSION_TIMEOUT_MS = 15000;  // 15s idle → close

  // FreeRTOS task handles
  TaskHandle_t net_task_handle_{nullptr};
  TaskHandle_t spk_task_handle_{nullptr};

  static void spk_task_(void *param);
  void spk_task_loop_();

  // Wyoming protocol helpers
  bool send_event_(const char *type, const char *data_json = nullptr,
                   const uint8_t *payload = nullptr,
                   size_t payload_len = 0);
  bool receive_events_();

  // Network task (runs on Core 1)
  static void net_task_(void *param);
  void net_task_loop_();

  bool connect_();
  void disconnect_();
  void send_audio_start_();
  void send_audio_stop_();
  void handle_received_event_(const std::string &type,
                              const std::string &data_json,
                              const std::vector<uint8_t> &payload);
};

template<typename... Ts>
class StartAction : public Action<Ts...>,
                    public Parented<WyomingTcpClient> {
 public:
  void play(const Ts &...x) override { this->parent_->start(); }
};

template<typename... Ts>
class StopAction : public Action<Ts...>,
                   public Parented<WyomingTcpClient> {
 public:
  void play(const Ts &...x) override { this->parent_->stop(); }
};

}  // namespace wyoming_tcp_client
}  // namespace esphome
