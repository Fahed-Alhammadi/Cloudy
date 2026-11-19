// Cloudy's Explorer badges (Windows): three icon overlay handlers (synced, syncing, not synced) in one DLL. Explorer,
// and every program that shows a file dialog, asks each handler about each item it draws (IsMemberOf); that call must
// be quick, so it only looks in a cache. Items not in the cache are asked of the Cloudy app by a background thread
// over a loopback connection; when the answer comes, Explorer is told to draw that item again (SHChangeNotify).
// The app writes its port and two random values to %APPDATA%\Cloudy\finder.json; protocol and the two proofs: see
// desktop/src/main/finder.ts. When Cloudy is not running there are no badges.
// Build: explorer/build.mjs (MSVC). The Cloudy app registers this DLL for the current user (src/main/badges-win.ts).
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <atomic>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "advapi32.lib")

namespace {

// {5C2A6D8E-4B1F-4E3A-9C7D-2F8E1A6B3C01} … 03: synced, syncing, error (also in src/main/badges-win.ts).
const CLSID kClsids[3] = {
    {0x5c2a6d8e, 0x4b1f, 0x4e3a, {0x9c, 0x7d, 0x2f, 0x8e, 0x1a, 0x6b, 0x3c, 0x01}},
    {0x5c2a6d8e, 0x4b1f, 0x4e3a, {0x9c, 0x7d, 0x2f, 0x8e, 0x1a, 0x6b, 0x3c, 0x02}},
    {0x5c2a6d8e, 0x4b1f, 0x4e3a, {0x9c, 0x7d, 0x2f, 0x8e, 0x1a, 0x6b, 0x3c, 0x03}},
};
const char *const kBadgeIds[3] = {"synced", "syncing", "error"};
enum : uint8_t { kNone = 0xff };

HMODULE g_module = nullptr;
std::atomic<long> g_objects{0};

// ------------------------------------------------------------------ text

std::string Utf8(const std::wstring &w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}

std::wstring Wide(const std::string &s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
  return w;
}

/** One spelling per item: Windows names are case-insensitive (upper-case invariant, as NTFS compares). */
std::wstring Key(const std::wstring &p) {
  std::wstring k = p;
  if (!k.empty()) LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_UPPERCASE, p.data(), (int)p.size(), k.data(), (int)k.size(), nullptr, nullptr, 0);
  while (k.size() > 3 && k.back() == L'\\') k.pop_back();
  return k;
}

// ------------------------------------------------------------------ JSON (just what the protocol uses)

struct Json {
  enum Type { Null, Bool, Num, Str, Arr, Obj } type = Null;
  std::string str;
  std::vector<Json> arr;
  std::vector<std::pair<std::string, Json>> obj;
  const Json *Get(const char *name) const {
    for (auto &kv : obj) if (kv.first == name) return &kv.second;
    return nullptr;
  }
};

struct Parser {
  const char *p, *end;
  int depth = 0;
  void Ws() { while (p < end && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) ++p; }
  bool Lit(const char *s) {
    size_t n = strlen(s);
    if ((size_t)(end - p) < n || memcmp(p, s, n) != 0) return false;
    p += n;
    return true;
  }
  static void Put(std::string &out, uint32_t c) {
    if (c < 0x80) out += (char)c;
    else if (c < 0x800) { out += (char)(0xc0 | c >> 6); out += (char)(0x80 | (c & 0x3f)); }
    else if (c < 0x10000) { out += (char)(0xe0 | c >> 12); out += (char)(0x80 | (c >> 6 & 0x3f)); out += (char)(0x80 | (c & 0x3f)); }
    else { out += (char)(0xf0 | c >> 18); out += (char)(0x80 | (c >> 12 & 0x3f)); out += (char)(0x80 | (c >> 6 & 0x3f)); out += (char)(0x80 | (c & 0x3f)); }
  }
  bool Hex4(uint32_t &v) {
    if (end - p < 4) return false;
    v = 0;
    for (int i = 0; i < 4; ++i) {
      char c = *p++;
      v <<= 4;
      if (c >= '0' && c <= '9') v |= c - '0';
      else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10;
      else return false;
    }
    return true;
  }
  bool String(std::string &out) {
    if (p >= end || *p != '"') return false;
    ++p;
    while (p < end && *p != '"') {
      if (*p != '\\') { out += *p++; continue; }
      if (++p >= end) return false;
      char c = *p++;
      switch (c) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          uint32_t v;
          if (!Hex4(v)) return false;
          if (v >= 0xd800 && v < 0xdc00 && end - p >= 6 && p[0] == '\\' && p[1] == 'u') {
            p += 2;
            uint32_t lo;
            if (!Hex4(lo) || lo < 0xdc00 || lo >= 0xe000) return false;
            v = 0x10000 + ((v - 0xd800) << 10) + (lo - 0xdc00);
          }
          Put(out, v);
          break;
        }
        default: return false;
      }
    }
    if (p >= end) return false;
    ++p;
    return true;
  }
  bool Value(Json &v) {
    if (++depth > 16) return false;
    Ws();
    bool ok = false;
    if (p >= end) ok = false;
    else if (*p == '"') { v.type = Json::Str; ok = String(v.str); }
    else if (*p == '{') {
      v.type = Json::Obj;
      ++p; Ws();
      if (p < end && *p == '}') { ++p; ok = true; }
      else for (;;) {
        Ws();
        std::pair<std::string, Json> kv;
        if (!String(kv.first)) break;
        Ws();
        if (p >= end || *p++ != ':') break;
        if (!Value(kv.second)) break;
        v.obj.push_back(std::move(kv));
        Ws();
        if (p < end && *p == ',') { ++p; continue; }
        if (p < end && *p == '}') { ++p; ok = true; }
        break;
      }
    } else if (*p == '[') {
      v.type = Json::Arr;
      ++p; Ws();
      if (p < end && *p == ']') { ++p; ok = true; }
      else for (;;) {
        Json item;
        if (!Value(item)) break;
        v.arr.push_back(std::move(item));
        Ws();
        if (p < end && *p == ',') { ++p; continue; }
        if (p < end && *p == ']') { ++p; ok = true; }
        break;
      }
    } else if (Lit("null")) { v.type = Json::Null; ok = true; }
    else if (Lit("true") || Lit("false")) { v.type = Json::Bool; ok = true; }
    else if (*p == '-' || (*p >= '0' && *p <= '9')) {
      v.type = Json::Num;
      const char *start = p;
      while (p < end && *p && strchr("+-0123456789.eE", *p)) ++p;
      v.str.assign(start, p);
      ok = true;
    }
    --depth;
    return ok;
  }
};

bool ParseJson(const std::string &text, Json &out) {
  Parser ps{text.data(), text.data() + text.size()};
  if (!ps.Value(out)) return false;
  ps.Ws();
  return ps.p == ps.end;
}

void Quote(std::string &out, const std::string &s) {
  out += '"';
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { out += '\\'; out += (char)c; }
    else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); out += b; }
    else out += (char)c;
  }
  out += '"';
}

// ------------------------------------------------------------------ talking to Cloudy

struct Entry {
  std::wstring path; // as Explorer spelled it (the app answers with the same text)
  uint8_t badge = kNone;
  bool answered = false;
  bool queued = false; // in queue_ (once: a "changed everything" must not add 200,000 copies again and again)
};

class Client {
 public:
  static Client &Get() {
    static Client *c = new Client(); // never destroyed: the thread may still use it while the process ends
    return *c;
  }

  /** 0 synced, 1 syncing, 2 error, kNone: none or not known yet (then it is asked, and Explorer told later). */
  uint8_t Badge(const wchar_t *path) {
    Start();
    std::wstring p(path), k = Key(p);
    std::lock_guard<std::mutex> lock(mu_);
    if (!verified_ || !UnderFolders(k)) return kNone;
    auto it = items_.find(k);
    if (it != items_.end()) return it->second.badge;
    if (items_.size() >= 200000) Forget(); // a bound; whatever Explorer still shows is asked again
    Enqueue(items_.emplace(k, Entry{p}).first);
    return kNone;
  }

 private:
  std::mutex mu_;
  std::atomic<bool> started_{false};
  bool verified_ = false;
  std::vector<std::wstring> folders_, folderKeys_;
  std::unordered_map<std::wstring, Entry> items_;
  std::deque<std::wstring> queue_; // keys of the items to ask about (each at most once: Entry::queued)
  SOCKET sock_ = INVALID_SOCKET;
  std::string inbuf_;

  void Start() {
    bool expected = false;
    if (!started_.compare_exchange_strong(expected, true)) return;
    // The thread lives as long as the process: keep this DLL loaded (DllCanUnloadNow then says no anyway).
    HMODULE self;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN, (LPCWSTR)&kClsids, &self);
    HANDLE t = CreateThread(nullptr, 0, [](void *) -> DWORD { Get().Run(); return 0; }, nullptr, 0, nullptr);
    if (t) CloseHandle(t);
  }

  void Enqueue(std::unordered_map<std::wstring, Entry>::iterator it) {
    if (it->second.queued) return;
    it->second.queued = true;
    queue_.push_back(it->first);
  }

  void Forget() {
    items_.clear();
    queue_.clear();
  }

  bool UnderFolders(const std::wstring &k) const {
    for (auto &f : folderKeys_) {
      if (k.size() >= f.size() && k.compare(0, f.size(), f) == 0 && (k.size() == f.size() || k[f.size()] == L'\\')) return true;
    }
    return false;
  }

  static std::wstring PortFile() {
    wchar_t buf[2048];
    DWORD n = GetEnvironmentVariableW(L"CLOUDY_BADGES_FILE", buf, 2048); // tests
    if (n > 0 && n < 2048) return buf;
    PWSTR appdata = nullptr;
    std::wstring out;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, nullptr, &appdata))) out = std::wstring(appdata) + L"\\Cloudy\\finder.json";
    CoTaskMemFree(appdata);
    return out;
  }

  bool ReadPortFile(int &port, std::string &secret, std::string &app) {
    std::wstring file = PortFile();
    if (file.empty()) return false;
    HANDLE h = CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    char data[4096];
    DWORD got = 0;
    BOOL ok = ReadFile(h, data, sizeof data, &got, nullptr);
    CloseHandle(h);
    if (!ok || got == 0 || got >= sizeof data) return false;
    Json j;
    if (!ParseJson(std::string(data, got), j) || j.type != Json::Obj) return false;
    const Json *jp = j.Get("port"), *js = j.Get("secret"), *ja = j.Get("app");
    if (!jp || !js || !ja || jp->type != Json::Num || js->type != Json::Str || ja->type != Json::Str) return false;
    port = atoi(jp->str.c_str());
    if (port <= 0 || port > 65535) return false;
    secret = js->str;
    app = ja->str;
    return true;
  }

  bool SendLine(const std::string &line) {
    std::string s = line + "\n";
    const char *p = s.data();
    int left = (int)s.size();
    while (left > 0) {
      int n = send(sock_, p, left, 0);
      if (n <= 0) return false;
      p += n;
      left -= n;
    }
    return true;
  }

  /** Reads what is there (waits at most `ms`); false when the connection is gone or a line is longer than `max`. */
  bool ReadSome(std::vector<std::string> &lines, int ms, size_t max) {
    fd_set rd;
    FD_ZERO(&rd);
    FD_SET(sock_, &rd);
    timeval tv{ms / 1000, (ms % 1000) * 1000};
    int r = select(0, &rd, nullptr, nullptr, &tv);
    if (r < 0) return false;
    if (r == 0) return true;
    char buf[65536];
    int n = recv(sock_, buf, sizeof buf, 0);
    if (n <= 0) return false;
    inbuf_.append(buf, n);
    size_t nl;
    while ((nl = inbuf_.find('\n')) != std::string::npos) {
      if (nl > max) return false;
      lines.push_back(inbuf_.substr(0, nl));
      inbuf_.erase(0, nl + 1);
    }
    return inbuf_.size() <= max;
  }

  static void Notify(const std::vector<std::wstring> &paths, LONG event = SHCNE_UPDATEITEM) {
    for (auto &p : paths) SHChangeNotify(event, SHCNF_PATHW | SHCNF_FLUSHNOWAIT, p.c_str(), nullptr);
  }

  /** Cloudy is gone: no folders, no badges; Explorer draws what it shows of the folders again. */
  void Disconnected() {
    std::vector<std::wstring> old;
    {
      std::lock_guard<std::mutex> lock(mu_);
      verified_ = false;
      old = folders_;
      folders_.clear();
      folderKeys_.clear();
      Forget();
    }
    if (sock_ != INVALID_SOCKET) closesocket(sock_);
    sock_ = INVALID_SOCKET;
    inbuf_.clear();
    Notify(old, SHCNE_UPDATEDIR);
    Notify(old);
  }

  void Run() {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return;
    for (;;) {
      // Never let an exception (out of memory) end the program this DLL is loaded into.
      try { Session(); } catch (...) {}
      try { Disconnected(); } catch (...) {}
      Sleep(3000);
    }
  }

  void Session() {
    int port;
    std::string secret, app;
    if (!ReadPortFile(port, secret, app)) return;
    sock_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock_ == INVALID_SOCKET) return;
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons((u_short)port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(sock_, (sockaddr *)&addr, sizeof addr) != 0) return;
    BOOL nodelay = TRUE;
    setsockopt(sock_, IPPROTO_TCP, TCP_NODELAY, (const char *)&nodelay, sizeof nodelay);

    // The app proves first that it read finder.json (else this is someone else on that port: say nothing). Its line
    // is short; anything longer is not Cloudy and is not read on.
    std::vector<std::string> lines;
    for (int waited = 0; lines.empty(); waited += 100) {
      if (waited > 10000 || !ReadSome(lines, 100, 512)) return;
    }
    Json first;
    const Json *proof;
    if (!ParseJson(lines[0], first) || !(proof = first.Get("app")) || proof->type != Json::Str || proof->str != app) return;
    lines.erase(lines.begin());
    std::string hello = "{\"hello\":";
    Quote(hello, secret);
    if (!SendLine(hello + "}")) return;
    {
      std::lock_guard<std::mutex> lock(mu_);
      verified_ = true;
    }
    for (;;) {
      for (auto &l : lines) Handle(l);
      lines.clear();
      if (!Flush()) return;
      if (!ReadSome(lines, 50, 16 * 1024 * 1024)) return;
    }
  }

  /** Sends what Explorer asked about, in lines of at most 1,000 items. */
  bool Flush() {
    std::vector<std::wstring> batch;
    {
      std::lock_guard<std::mutex> lock(mu_);
      while (!queue_.empty() && batch.size() < 1000) {
        auto it = items_.find(queue_.front());
        queue_.pop_front();
        if (it == items_.end() || !it->second.queued) continue;
        it->second.queued = false;
        batch.push_back(it->second.path);
      }
    }
    if (batch.empty()) return true;
    std::string line = "{\"ask\":[";
    for (size_t i = 0; i < batch.size(); ++i) {
      if (i) line += ',';
      Quote(line, Utf8(batch[i]));
    }
    return SendLine(line + "]}");
  }

  void Handle(const std::string &text) {
    Json msg;
    if (!ParseJson(text, msg) || msg.type != Json::Obj) return;
    std::vector<std::wstring> redraw, redrawDirs;
    {
      std::lock_guard<std::mutex> lock(mu_);
      if (const Json *f = msg.Get("folders"); f && f->type == Json::Arr) {
        redrawDirs = folders_;
        folders_.clear();
        folderKeys_.clear();
        for (auto &v : f->arr) {
          if (v.type != Json::Str) continue;
          folders_.push_back(Wide(v.str));
          folderKeys_.push_back(Key(folders_.back()));
        }
        Forget(); // asked again as Explorer draws them
        redrawDirs.insert(redrawDirs.end(), folders_.begin(), folders_.end());
      }
      if (const Json *b = msg.Get("badges"); b && b->type == Json::Obj) {
        for (auto &kv : b->obj) {
          if (kv.second.type != Json::Str) continue;
          std::wstring p = Wide(kv.first), k = Key(p);
          uint8_t badge = kNone;
          for (uint8_t i = 0; i < 3; ++i) if (kv.second.str == kBadgeIds[i]) badge = i;
          auto it = items_.find(k);
          if (it == items_.end()) continue; // forgotten meanwhile
          bool shown = it->second.answered ? it->second.badge != badge : badge != kNone;
          it->second.badge = badge;
          it->second.answered = true;
          if (shown) redraw.push_back(it->second.path);
        }
      }
      if (const Json *c = msg.Get("changed")) {
        // Ask again; the old badge stays until the answer (no flicker).
        if (c->type == Json::Arr) {
          for (auto &v : c->arr) {
            if (v.type != Json::Str) continue;
            auto it = items_.find(Key(Wide(v.str)));
            if (it != items_.end()) Enqueue(it);
          }
        } else if (c->type == Json::Null) {
          for (auto it = items_.begin(); it != items_.end(); ++it) Enqueue(it);
        }
      }
    }
    Notify(redrawDirs, SHCNE_UPDATEDIR);
    Notify(redrawDirs);
    Notify(redraw);
  }
};

// ------------------------------------------------------------------ COM

class Overlay final : public IShellIconOverlayIdentifier {
 public:
  explicit Overlay(int which) : which_(which) { ++g_objects; }
  ~Overlay() { --g_objects; }

  IFACEMETHODIMP QueryInterface(REFIID riid, void **ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IShellIconOverlayIdentifier) {
      *ppv = static_cast<IShellIconOverlayIdentifier *>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  IFACEMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
  IFACEMETHODIMP_(ULONG) Release() override {
    LONG n = InterlockedDecrement(&refs_);
    if (n == 0) delete this;
    return n;
  }

  IFACEMETHODIMP IsMemberOf(PCWSTR path, DWORD) override {
    if (!path || !*path) return S_FALSE;
    try {
      return Client::Get().Badge(path) == which_ ? S_OK : S_FALSE;
    } catch (...) {
      return S_FALSE; // out of memory: no badge rather than ending Explorer
    }
  }
  IFACEMETHODIMP GetOverlayInfo(PWSTR iconFile, int cch, int *index, DWORD *flags) override {
    if (!iconFile || !index || !flags) return E_POINTER;
    DWORD n = GetModuleFileNameW(g_module, iconFile, cch);
    if (n == 0 || n >= (DWORD)cch) return E_FAIL;
    *index = which_; // icons 101, 102, 103 in CloudyBadges.rc, in this order
    *flags = ISIOI_ICONFILE | ISIOI_ICONINDEX;
    return S_OK;
  }
  IFACEMETHODIMP GetPriority(int *priority) override {
    if (!priority) return E_POINTER;
    *priority = 0;
    return S_OK;
  }

 private:
  LONG refs_ = 1;
  int which_;
};

class Factory final : public IClassFactory {
 public:
  explicit Factory(int which) : which_(which) { ++g_objects; }
  ~Factory() { --g_objects; }
  IFACEMETHODIMP QueryInterface(REFIID riid, void **ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IClassFactory) {
      *ppv = static_cast<IClassFactory *>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  IFACEMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
  IFACEMETHODIMP_(ULONG) Release() override {
    LONG n = InterlockedDecrement(&refs_);
    if (n == 0) delete this;
    return n;
  }
  IFACEMETHODIMP CreateInstance(IUnknown *outer, REFIID riid, void **ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (outer) return CLASS_E_NOAGGREGATION;
    Overlay *o = new (std::nothrow) Overlay(which_);
    if (!o) return E_OUTOFMEMORY;
    HRESULT hr = o->QueryInterface(riid, ppv);
    o->Release();
    return hr;
  }
  IFACEMETHODIMP LockServer(BOOL) override { return S_OK; }

 private:
  LONG refs_ = 1;
  int which_;
};

}  // namespace

extern "C" BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    g_module = instance;
    DisableThreadLibraryCalls(instance);
  }
  return TRUE;
}

STDAPI DllGetClassObject(REFCLSID clsid, REFIID riid, void **ppv) {
  if (!ppv) return E_POINTER;
  *ppv = nullptr;
  for (int i = 0; i < 3; ++i) {
    if (clsid != kClsids[i]) continue;
    Factory *f = new (std::nothrow) Factory(i);
    if (!f) return E_OUTOFMEMORY;
    HRESULT hr = f->QueryInterface(riid, ppv);
    f->Release();
    return hr;
  }
  return CLASS_E_CLASSNOTAVAILABLE;
}

// Once the connection thread runs, the DLL is pinned; before that it may go when nothing uses it.
STDAPI DllCanUnloadNow() { return g_objects == 0 ? S_OK : S_FALSE; }
