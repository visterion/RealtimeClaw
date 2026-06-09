import esphome.codegen as cg
import esphome.config_validation as cv
from esphome import automation
from esphome.automation import maybe_simple_id
from esphome.components import microphone, speaker
from esphome.const import CONF_ID, CONF_PORT

CONF_HOST = "host"

DEPENDENCIES = ["microphone"]
AUTO_LOAD = ["audio"]

wyoming_tcp_client_ns = cg.esphome_ns.namespace("wyoming_tcp_client")
WyomingTcpClient = wyoming_tcp_client_ns.class_(
    "WyomingTcpClient", cg.Component
)

CONF_SPEAKER = "speaker"
CONF_MICROPHONE = "microphone"

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(WyomingTcpClient),
        cv.Required(CONF_HOST): cv.string,
        cv.Optional(CONF_PORT, default=10300): cv.port,
        cv.Required(CONF_MICROPHONE): microphone.microphone_source_schema(),
        cv.Required(CONF_SPEAKER): cv.use_id(speaker.Speaker),
    }
).extend(cv.COMPONENT_SCHEMA)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)

    cg.add(var.set_host(config[CONF_HOST]))
    cg.add(var.set_port(config[CONF_PORT]))

    mic_source = await microphone.microphone_source_to_code(
        config[CONF_MICROPHONE]
    )
    cg.add(var.set_microphone_source(mic_source))

    spk = await cg.get_variable(config[CONF_SPEAKER])
    cg.add(var.set_speaker(spk))


# Start action
StartAction = wyoming_tcp_client_ns.class_(
    "StartAction", automation.Action
)

WYOMING_TCP_CLIENT_ACTION_SCHEMA = maybe_simple_id(
    {cv.GenerateID(): cv.use_id(WyomingTcpClient)}
)

@automation.register_action(
    "wyoming_tcp_client.start", StartAction,
    WYOMING_TCP_CLIENT_ACTION_SCHEMA,
)
async def wyoming_start_to_code(config, action_id, template_arg, args):
    var = cg.new_Pvariable(action_id, template_arg)
    await cg.register_parented(var, config[CONF_ID])
    return var

# Stop action
StopAction = wyoming_tcp_client_ns.class_(
    "StopAction", automation.Action
)

@automation.register_action(
    "wyoming_tcp_client.stop", StopAction,
    WYOMING_TCP_CLIENT_ACTION_SCHEMA,
)
async def wyoming_stop_to_code(config, action_id, template_arg, args):
    var = cg.new_Pvariable(action_id, template_arg)
    await cg.register_parented(var, config[CONF_ID])
    return var
