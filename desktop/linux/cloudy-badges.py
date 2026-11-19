# Cloudy: sync badges (emblems) in GNOME Files (Nautilus), Nemo and Caja. A green tick on synced items, blue arrows
# while they sync, a red mark on items that could not be synced.
#
# The Cloudy app copies this file into ~/.local/share/{nautilus,nemo,caja}-python/extensions/ with HOST set in its
# first line, and the emblem pictures into ~/.local/share/icons/hicolor/. It needs the file manager's Python extension
# package (python3-nautilus, python3-nemo or python3-caja on Debian and Ubuntu). The extension knows nothing itself:
# it asks the Cloudy app over a loopback connection whose port and two random values the app writes to
# ~/.config/Cloudy/finder.json. Protocol: see desktop/src/main/finder.ts. When Cloudy is not running there are no
# badges.
import json
import os
import socket

import gi
from gi.repository import GLib, GObject

try:
    HOST  # set by the Cloudy app in the copy it installs
except NameError:
    HOST = 'nautilus'

if HOST == 'nemo':
    gi.require_version('Nemo', '3.0')
    from gi.repository import Nemo as Ext
elif HOST == 'caja':
    gi.require_version('Caja', '2.0')
    from gi.repository import Caja as Ext
else:
    for _v in ('4.1', '4.0', '3.0'):
        try:
            gi.require_version('Nautilus', _v)
            break
        except ValueError:
            pass
    from gi.repository import Nautilus as Ext

EMBLEMS = {'synced': 'emblem-cloudy-synced', 'syncing': 'emblem-cloudy-syncing', 'error': 'emblem-cloudy-error'}
MAX_KNOWN = 50000


def port_file():
    if os.environ.get('CLOUDY_BADGES_FILE'):  # tests
        return os.environ['CLOUDY_BADGES_FILE']
    config = os.environ.get('XDG_CONFIG_HOME') or os.path.join(os.path.expanduser('~'), '.config')
    return os.path.join(config, 'Cloudy', 'finder.json')


class Connection:
    """The link to the Cloudy app, on the file manager's main loop (no threads: GLib calls back when data comes)."""

    def __init__(self):
        self.sock = None
        self.watch = None
        self.inbuf = b''
        self.outbuf = b''
        self.out_watch = None
        self.app = None
        self.secret = None
        self.verified = False
        self.folders = []
        self.badges = {}    # path -> 'synced' | 'syncing' | 'error' | '' (answered)
        self.files = {}     # path -> the FileInfo the file manager asked about (to make it ask again)
        self.waiting = set()
        self.flush_planned = False
        GLib.idle_add(self.connect)

    # ---- the file manager

    def badge_for(self, path, info):
        """The emblem for `path` now (None: not known yet, asked; the item is redrawn when the answer comes)."""
        if not self.verified or not self.under(path):
            return None
        if path not in self.files and len(self.files) >= MAX_KNOWN:
            self.files.clear()  # a bound; what is still shown is asked again
            self.badges.clear()
        self.files[path] = info
        if path in self.badges:
            return EMBLEMS.get(self.badges[path])
        self.ask([path])
        return None

    def under(self, path):
        return any(path == f or path.startswith(f.rstrip('/') + '/') for f in self.folders)

    def redraw(self, paths):
        for p in paths:
            info = self.files.get(p)
            if info is not None:
                info.invalidate_extension_info()

    # ---- talking to Cloudy

    def read_port_file(self):
        try:
            with open(port_file(), encoding='utf-8') as f:
                o = json.load(f)
            port = o['port']
            if isinstance(port, int) and 0 < port < 65536 and isinstance(o['secret'], str) and isinstance(o['app'], str):
                return port, o['secret'], o['app']
        except (OSError, ValueError, KeyError, TypeError):
            pass
        return None

    def connect(self):
        found = self.read_port_file()
        if not found:
            GLib.timeout_add_seconds(3, self.connect)
            return False
        port, self.secret, self.app = found
        try:
            s = socket.create_connection(('127.0.0.1', port), timeout=2)
        except OSError:
            GLib.timeout_add_seconds(3, self.connect)
            return False
        s.setblocking(False)
        self.sock = s
        self.inbuf = b''
        self.outbuf = b''
        self.verified = False
        self.watch = GLib.io_add_watch(s.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, self.readable)
        # Cloudy says who it is at once; something else that took over a stale port gets 10 seconds.
        GLib.timeout_add_seconds(10, self.no_proof, s)
        return False

    def no_proof(self, s):
        if self.sock is s and not self.verified:
            self.disconnected()
        return False

    def disconnected(self):
        for w in (self.watch, self.out_watch):
            if w:
                GLib.source_remove(w)
        self.watch = self.out_watch = None
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = None
        self.verified = False
        self.folders = []
        self.badges.clear()
        self.waiting.clear()
        # Cloudy quit: no badges that could be wrong.
        self.redraw(list(self.files))
        GLib.timeout_add_seconds(3, self.connect)

    def readable(self, fd, cond):
        try:
            data = self.sock.recv(65536)
        except BlockingIOError:
            return True
        except OSError:
            data = b''
        if not data:
            self.disconnected()
            return False
        self.inbuf += data
        if len(self.inbuf) > 16 * 1024 * 1024:
            self.disconnected()
            return False
        if not self.verified and len(self.inbuf) > 512:  # the app's first line is short
            self.disconnected()
            return False
        while b'\n' in self.inbuf:
            line, self.inbuf = self.inbuf.split(b'\n', 1)
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if isinstance(msg, dict) and not self.handle(msg):
                self.disconnected()
                return False
        return True

    def handle(self, msg):
        if not self.verified:
            # The app proves first that it read finder.json (else this is someone else on that port: say nothing).
            if msg.get('app') != self.app:
                return False
            self.verified = True
            self.send({'hello': self.secret})
            return True
        if isinstance(msg.get('folders'), list):
            self.folders = [f for f in msg['folders'] if isinstance(f, str)]
            self.badges.clear()
            self.redraw(list(self.files))
        badges = msg.get('badges')
        if isinstance(badges, dict):
            changed = []
            for p, b in badges.items():
                if not isinstance(b, str):
                    continue
                if self.badges.get(p) != b and (p in self.badges or b):
                    changed.append(p)
                self.badges[p] = b
            self.redraw(changed)
        if 'changed' in msg:
            c = msg['changed']
            # Ask again; the old emblem stays until the answer.
            self.ask([p for p in c if isinstance(p, str) and p in self.files] if isinstance(c, list) else list(self.files))
        return True

    def ask(self, paths):
        if not paths:
            return
        self.waiting.update(paths)
        if not self.flush_planned:
            self.flush_planned = True
            GLib.timeout_add(50, self.flush)

    def flush(self):
        self.flush_planned = False
        if self.sock is None or not self.verified or not self.waiting:
            return False
        items = list(self.waiting)
        self.waiting.clear()
        for i in range(0, len(items), 1000):  # the app reads lines up to a limit
            self.send({'ask': items[i:i + 1000]})
        return False

    def send(self, obj):
        self.outbuf += json.dumps(obj).encode() + b'\n'
        self.write_out()

    def write_out(self, *_):
        while self.outbuf and self.sock is not None:
            try:
                n = self.sock.send(self.outbuf, socket.MSG_NOSIGNAL)
            except BlockingIOError:
                break
            except OSError:
                self.disconnected()
                return False
            self.outbuf = self.outbuf[n:]
        if self.outbuf and self.sock is not None and not self.out_watch:
            self.out_watch = GLib.io_add_watch(self.sock.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_OUT, self.writable)
        return False

    def writable(self, *_):
        self.out_watch = None
        self.write_out()
        return False


_connection = None


class CloudyBadges(GObject.GObject, Ext.InfoProvider):
    def __init__(self):
        super().__init__()
        global _connection
        if _connection is None:
            _connection = Connection()

    def update_file_info(self, info):
        location = info.get_location()
        path = location.get_path() if location is not None else None
        if not path:
            return
        emblem = _connection.badge_for(path, info)
        if emblem:
            info.add_emblem(emblem)
