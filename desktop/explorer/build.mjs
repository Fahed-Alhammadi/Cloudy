// Builds explorer/build/CloudyBadges.dll (x64) with MSVC (Visual Studio or its Build Tools, found with vswhere).
// --test also builds explorer/build/harness.exe for test/explorer.test.ts. Windows only; elsewhere it does nothing,
// so `npm run dist:win` stays the same command everywhere.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('explorer/build.mjs: not Windows, skipped');
  process.exit(0);
}
const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(dir, 'build');
mkdirSync(out, { recursive: true });

const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
const vs = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
const vcvars = path.join(vs, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
if (!existsSync(vcvars)) throw new Error(`No MSVC found (${vcvars})`);

// Static C runtime (/MT): Explorer and other programs load this DLL; it must not need a Visual C++ redistributable.
const cl = '/nologo /O2 /EHsc /std:c++17 /W4 /WX /MT /DUNICODE /D_UNICODE';
const steps = [
  `rc /nologo /fo "${out}\\CloudyBadges.res" CloudyBadges.rc`,
  `cl ${cl} /LD /Fo"${out}\\\\" /Fe"${out}\\CloudyBadges.dll" CloudyBadges.cpp "${out}\\CloudyBadges.res" /link /DEF:CloudyBadges.def`,
];
if (process.argv.includes('--test')) steps.push(`cl ${cl} /Fo"${out}\\\\" /Fe"${out}\\harness.exe" test\\harness.cpp`);
const script = path.join(out, 'build.cmd');
const { writeFileSync } = await import('node:fs');
writeFileSync(script, ['@echo off', `call "${vcvars}" x64 >nul || exit /b 1`, `cd /d "${dir}"`, ...steps.map((s) => `${s} || exit /b 1`)].join('\r\n') + '\r\n');
execFileSync('cmd.exe', ['/d', '/s', '/c', `"${script}"`], { stdio: 'inherit', windowsVerbatimArguments: true });
console.log(`explorer/build.mjs: ${path.join(out, 'CloudyBadges.dll')}`);
