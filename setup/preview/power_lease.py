"""A temporary performance hold while streaming on mains power.

power-profiles-daemon releases the hold automatically if this process exits.
This never changes the user's selected profile or overrides thermal limits.
"""
import time
from gi.repository import Gio, GLib

NAME='org.freedesktop.UPower.PowerProfiles'
PATH='/org/freedesktop/UPower/PowerProfiles'

class PowerLease:
    def __init__(self, bus=None):
        self.bus=bus
        self.cookie=None
        self.active=False
        self.checked=-10.0
        self.warned=False

    def call(self,destination,path,interface,method,signature,values):
        if self.bus is None:self.bus=Gio.bus_get_sync(Gio.BusType.SYSTEM,None)
        return self.bus.call_sync(destination,path,interface,method,
            GLib.Variant(signature,values),None,Gio.DBusCallFlags.NO_AUTO_START,1000,None).unpack()

    def set_active(self,active):
        self.active=active
        self.refresh(force=True)

    def refresh(self,force=False):
        now=time.monotonic()
        if not force and now-self.checked<2:return
        self.checked=now
        try:
            on_battery=True
            if self.active:
                on_battery=self.call('org.freedesktop.UPower','/org/freedesktop/UPower',
                    'org.freedesktop.DBus.Properties','Get','(ss)',('org.freedesktop.UPower','OnBattery'))[0]
            if self.active and not on_battery:
                if self.cookie is None:
                    self.cookie=self.call(NAME,PATH,NAME,'HoldProfile','(sss)',
                        ('performance','Transmisión de pantalla Phonepad','app.phonepad'))[0]
                    print('rtc performance hold active',flush=True)
            else:self.close()
        except Exception:
            # An unavailable service must not prevent video or leak an old hold.
            self.close()
            if not self.warned:
                print('rtc performance hold unavailable; using system profile',flush=True)
                self.warned=True

    def close(self):
        if self.cookie is not None:
            try:
                self.call(NAME,PATH,NAME,'ReleaseProfile','(u)',(self.cookie,))
                self.cookie=None
                print('rtc performance hold released',flush=True)
            except Exception:pass  # Daemon also releases on bus disconnect.
