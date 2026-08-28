#!/usr/bin/env python3
"""ToneRelay BLE GATT peripheral.

Advertises a custom service. Writes to the command characteristic are JSON
objects; responses are sent as chunked notifications on the response
characteristic. USB work is delegated to openhx-cli so the Helix interface is
claimed only for the duration of each command and released afterwards.
"""

from __future__ import annotations

import json
import logging
import signal
import sys
import threading
from pathlib import Path

import dbus
import dbus.exceptions
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

sys.path.insert(0, str(Path(__file__).resolve().parent))
from protocol import cli_path, handle_command, helix_present

# uuid5(NAMESPACE_DNS, "hxblue.helix-bridge.gatt.*")
SERVICE_UUID = "363e0bb2-e8d2-5efd-a0ca-f430385a2b5c"
CMD_UUID = "6bbfcaf0-a29a-5a62-b736-8b5db334d342"
RSP_UUID = "37470314-79b2-5e4b-a54d-3080f3806886"
STATUS_UUID = "87bec7b0-2941-5235-8b5a-fd79587d326c"

BLUEZ_SERVICE = "org.bluez"
GATT_MANAGER_IFACE = "org.bluez.GattManager1"
LE_ADVERTISING_MANAGER_IFACE = "org.bluez.LEAdvertisingManager1"
DBUS_OM_IFACE = "org.freedesktop.DBus.ObjectManager"
DBUS_PROP_IFACE = "org.freedesktop.DBus.Properties"
GATT_SERVICE_IFACE = "org.bluez.GattService1"
GATT_CHRC_IFACE = "org.bluez.GattCharacteristic1"
LE_ADVERTISEMENT_IFACE = "org.bluez.LEAdvertisement1"
ADAPTER_IFACE = "org.bluez.Adapter1"

APP_PATH = "/org/tonerelay/app"
ADV_PATH = "/org/tonerelay/advertisement0"
ADAPTER_PATH = "/org/bluez/hci0"

LOCAL_NAME = "ToneRelay"
CHUNK = 160  # conservative ATT payload; clients reassemble regardless of MTU

LOG = logging.getLogger("tonerelay")



class InvalidArgsException(dbus.exceptions.DBusException):
    _dbus_error_name = "org.freedesktop.DBus.Error.InvalidArgs"


class NotSupportedException(dbus.exceptions.DBusException):
    _dbus_error_name = "org.bluez.Error.NotSupported"


class Application(dbus.service.Object):
    def __init__(self, bus):
        self.path = APP_PATH
        self.services = []
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def add_service(self, service):
        self.services.append(service)

    @dbus.service.method(DBUS_OM_IFACE, out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self):
        response = {}
        for service in self.services:
            response[service.get_path()] = service.get_properties()
            for chrc in service.get_characteristics():
                response[chrc.get_path()] = chrc.get_properties()
        return response


class Service(dbus.service.Object):
    def __init__(self, bus, index, uuid, primary):
        self.path = f"{APP_PATH}/service{index}"
        self.uuid = uuid
        self.primary = primary
        self.characteristics = []
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def add_characteristic(self, chrc):
        self.characteristics.append(chrc)

    def get_characteristics(self):
        return self.characteristics

    def get_properties(self):
        return {
            GATT_SERVICE_IFACE: {
                "UUID": self.uuid,
                "Primary": self.primary,
                "Characteristics": dbus.Array(
                    [c.get_path() for c in self.characteristics], signature="o"
                ),
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != GATT_SERVICE_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[GATT_SERVICE_IFACE]


class Characteristic(dbus.service.Object):
    def __init__(self, bus, index, uuid, flags, service):
        self.path = f"{service.path}/char{index}"
        self.uuid = uuid
        self.flags = flags
        self.service = service
        self.notifying = False
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def get_properties(self):
        return {
            GATT_CHRC_IFACE: {
                "Service": self.service.get_path(),
                "UUID": self.uuid,
                "Flags": self.flags,
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != GATT_CHRC_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[GATT_CHRC_IFACE]

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options):
        raise NotSupportedException()

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="aya{sv}")
    def WriteValue(self, value, options):
        raise NotSupportedException()

    @dbus.service.method(GATT_CHRC_IFACE)
    def StartNotify(self):
        self.notifying = True

    @dbus.service.method(GATT_CHRC_IFACE)
    def StopNotify(self):
        self.notifying = False

    @dbus.service.signal(DBUS_PROP_IFACE, signature="sa{sv}as")
    def PropertiesChanged(self, interface, changed, invalidated):
        pass

    def notify(self, payload: bytes):
        if not self.notifying:
            return
        self.PropertiesChanged(
            GATT_CHRC_IFACE,
            {"Value": dbus.Array(payload, signature="y")},
            [],
        )


class StatusCharacteristic(Characteristic):
    def ReadValue(self, options):
        body = json.dumps(
            {
                "usb": helix_present(),
                "vid": "0e41",
                "pid": "4248",
                "name": LOCAL_NAME,
            }
        ).encode()
        return dbus.Array(body, signature="y")


class CommandCharacteristic(Characteristic):
    def __init__(self, bus, index, uuid, flags, service, rsp_char: "ResponseCharacteristic"):
        super().__init__(bus, index, uuid, flags, service)
        self.rsp_char = rsp_char
        self.lock = threading.Lock()

    def WriteValue(self, value, options):
        raw = bytes(value)
        LOG.info("ble cmd write %d bytes", len(raw))
        thread = threading.Thread(target=self._run, args=(raw,), daemon=True)
        thread.start()

    def _run(self, raw: bytes):
        with self.lock:
            result = handle_command(raw)
        payload = json.dumps(result, separators=(",", ":")).encode("utf-8")
        GLib.idle_add(self.rsp_char.send_chunked, payload)


class ResponseCharacteristic(Characteristic):
    def send_chunked(self, payload: bytes):
        total = len(payload)
        if total == 0:
            payload = b"{}"
            total = 2
        offset = 0
        while offset < total:
            piece = payload[offset : offset + CHUNK]
            flags = 0
            if offset == 0:
                flags |= 0x01
            if offset + len(piece) >= total:
                flags |= 0x02
            header = bytes(
                [
                    flags,
                    (total >> 8) & 0xFF,
                    total & 0xFF,
                    (offset >> 8) & 0xFF,
                    offset & 0xFF,
                ]
            )
            self.notify(header + piece)
            offset += len(piece)
        return False


class Advertisement(dbus.service.Object):
    def __init__(self, bus):
        self.path = ADV_PATH
        self.bus = bus
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def get_properties(self):
        return {
            LE_ADVERTISEMENT_IFACE: {
                "Type": "peripheral",
                "ServiceUUIDs": dbus.Array([SERVICE_UUID], signature="s"),
                "LocalName": LOCAL_NAME,
                "IncludeTxPower": dbus.Boolean(True),
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != LE_ADVERTISEMENT_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[LE_ADVERTISEMENT_IFACE]

    @dbus.service.method(LE_ADVERTISEMENT_IFACE)
    def Release(self):
        LOG.info("advertisement released by bluez")


def find_adapter(bus):
    remote_om = dbus.Interface(bus.get_object(BLUEZ_SERVICE, "/"), DBUS_OM_IFACE)
    objects = remote_om.GetManagedObjects()
    for path, ifaces in objects.items():
        if ADAPTER_IFACE in ifaces:
            return path
    return ADAPTER_PATH


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    adapter_path = find_adapter(bus)
    adapter_props = dbus.Interface(bus.get_object(BLUEZ_SERVICE, adapter_path), DBUS_PROP_IFACE)
    adapter_props.Set(ADAPTER_IFACE, "Powered", dbus.Boolean(True))
    try:
        adapter_props.Set(ADAPTER_IFACE, "DiscoverableTimeout", dbus.UInt32(0))
        adapter_props.Set(ADAPTER_IFACE, "Discoverable", dbus.Boolean(True))
        adapter_props.Set(ADAPTER_IFACE, "Pairable", dbus.Boolean(True))
        adapter_props.Set(ADAPTER_IFACE, "Alias", dbus.String(LOCAL_NAME))
    except dbus.exceptions.DBusException as exc:
        LOG.warning("adapter property set failed: %s", exc)

    app = Application(bus)
    service = Service(bus, 0, SERVICE_UUID, True)
    rsp = ResponseCharacteristic(bus, 1, RSP_UUID, ["notify"], service)
    # Lab default: unencrypted write so a laptop can test without pairing.
    # Production / iOS should switch cmd flags to encrypt-write.
    cmd = CommandCharacteristic(
        bus, 0, CMD_UUID, ["write", "write-without-response"], service, rsp
    )
    status = StatusCharacteristic(bus, 2, STATUS_UUID, ["read", "notify"], service)
    service.add_characteristic(cmd)
    service.add_characteristic(rsp)
    service.add_characteristic(status)
    app.add_service(service)

    adv = Advertisement(bus)

    gatt_manager = dbus.Interface(
        bus.get_object(BLUEZ_SERVICE, adapter_path), GATT_MANAGER_IFACE
    )
    adv_manager = dbus.Interface(
        bus.get_object(BLUEZ_SERVICE, adapter_path), LE_ADVERTISING_MANAGER_IFACE
    )

    mainloop = GLib.MainLoop()

    def shutdown(*_args):
        LOG.info("shutting down BLE (unregister advertisement + gatt app)")
        try:
            adv_manager.UnregisterAdvertisement(adv.get_path())
        except dbus.exceptions.DBusException:
            pass
        try:
            gatt_manager.UnregisterApplication(app.get_path())
        except dbus.exceptions.DBusException:
            pass
        mainloop.quit()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    gatt_manager.RegisterApplication(
        app.get_path(),
        {},
        reply_handler=lambda: LOG.info("GATT application registered"),
        error_handler=lambda e: (LOG.error("RegisterApplication failed: %s", e), shutdown()),
    )
    adv_manager.RegisterAdvertisement(
        adv.get_path(),
        {},
        reply_handler=lambda: LOG.info("advertising as %s (%s)", LOCAL_NAME, SERVICE_UUID),
        error_handler=lambda e: (LOG.error("RegisterAdvertisement failed: %s", e), shutdown()),
    )

    LOG.info("Helix present=%s  cli=%s", helix_present(), cli_path())
    LOG.warning(
        "cmd characteristic allows unencrypted writes (lab). "
        "Require pairing before exposing this beyond a trusted network."
    )
    mainloop.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
