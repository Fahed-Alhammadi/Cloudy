// Test helper for test/explorer.test.ts (Windows only, built by explorer/build.mjs --test).
//   harness direct <dll> <path>=<synced|syncing|error|none> ...
//       loads the DLL itself and asks its three handlers until every item has the expected badge (10 s at most)
// Exit code 0 when everything came as expected.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlobj.h>
#include <cstdio>
#include <string>
#include <vector>

#pragma comment(lib, "ole32.lib")

static const CLSID kClsids[3] = {
    {0x5c2a6d8e, 0x4b1f, 0x4e3a, {0x9c, 0x7d, 0x2f, 0x8e, 0x1a, 0x6b, 0x3c, 0x01}},
    {0x5c2a6d8e, 0x4b1f, 0x4e3a, {0x9c, 0x7d, 0x2f, 0x8e, 0x1a, 0x6b, 0x3c, 0x02}},
    {0x5c2a6d8e, 0x4b1f, 0x4e3a, {0x9c, 0x7d, 0x2f, 0x8e, 0x1a, 0x6b, 0x3c, 0x03}},
};
static const wchar_t *kNames[4] = {L"synced", L"syncing", L"error", L"none"};

int wmain(int argc, wchar_t **argv) {
  if (argc < 3) return 2;
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  std::wstring mode = argv[1];
  if (mode == L"direct") {
    HMODULE dll = LoadLibraryW(argv[2]);
    if (!dll) { fwprintf(stderr, L"LoadLibrary failed: %lu\n", GetLastError()); return 2; }
    auto get = (HRESULT(STDAPICALLTYPE *)(REFCLSID, REFIID, void **))GetProcAddress(dll, "DllGetClassObject");
    if (!get) return 2;
    IShellIconOverlayIdentifier *ids[3] = {};
    for (int i = 0; i < 3; ++i) {
      IClassFactory *f = nullptr;
      if (FAILED(get(kClsids[i], IID_IClassFactory, (void **)&f))) return 3;
      if (FAILED(f->CreateInstance(nullptr, IID_IShellIconOverlayIdentifier, (void **)&ids[i]))) return 3;
      f->Release();
      wchar_t file[MAX_PATH];
      int index = -1;
      DWORD flags = 0;
      if (FAILED(ids[i]->GetOverlayInfo(file, MAX_PATH, &index, &flags)) || index != i) return 4;
    }
    std::vector<std::wstring> paths, want;
    for (int a = 3; a < argc; ++a) {
      std::wstring s = argv[a];
      size_t eq = s.rfind(L'=');
      paths.push_back(s.substr(0, eq));
      want.push_back(s.substr(eq + 1));
    }
    std::vector<std::wstring> got(paths.size());
    for (int round = 0; round < 200; ++round) {
      bool all = true;
      for (size_t k = 0; k < paths.size(); ++k) {
        int which = 3;
        for (int i = 0; i < 3; ++i) if (ids[i]->IsMemberOf(paths[k].c_str(), FILE_ATTRIBUTE_NORMAL) == S_OK) which = i;
        got[k] = kNames[which];
        if (got[k] != want[k]) all = false;
      }
      if (all) break;
      Sleep(50);
    }
    int bad = 0;
    for (size_t k = 0; k < paths.size(); ++k) {
      wprintf(L"%s\t%s\n", paths[k].c_str(), got[k].c_str());
      if (got[k] != want[k]) ++bad;
    }
    return bad ? 1 : 0;
  }
  return 2;
}
