// electron-builder afterPack hook (macOS): puts the Finder extension (finder/build.sh → finder/build/CloudyFinder.appex)
// into Cloudy.app/Contents/PlugIns and signs it with its own entitlements (sandbox + app group). electron-builder never
// signs anything in PlugIns itself; it signs the app around it afterwards, which seals the extension's signature.
// Identity: the one electron-builder signs the app with: CSC_NAME ("Fahed Alhammadi (TEAMID)", set by the release
// workflow), else the first Developer ID Application identity in the keychains (electron-builder's own discovery);
// unsigned builds (CSC_IDENTITY_AUTO_DISCOVERY=false, CI test builds) sign it ad hoc.
const { execFileSync } = require('node:child_process');
const { cpSync, existsSync } = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' && context.electronPlatformName !== 'mas') return;
  const root = path.join(__dirname, '..');
  const appex = path.join(root, 'finder', 'build', 'CloudyFinder.appex');
  if (!existsSync(appex)) throw new Error('finder/build/CloudyFinder.appex is missing: run finder/build.sh first (npm run dist:mac does)');
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const dest = path.join(app, 'Contents', 'PlugIns', 'CloudyFinder.appex');
  cpSync(appex, dest, { recursive: true, force: true });
  const identity = signingIdentity();
  const args = ['--force', '--sign', identity, '--options', 'runtime', '--entitlements', path.join(root, 'finder', 'CloudyFinder.entitlements')];
  if (identity !== '-') args.push('--timestamp');
  execFileSync('codesign', [...args, dest], { stdio: 'inherit' });
  console.log(`  • Finder extension signed (${identity === '-' ? 'ad hoc' : identity})`);
};

function signingIdentity() {
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') return '-';
  if (process.env.CSC_NAME) return `Developer ID Application: ${process.env.CSC_NAME.replace(/^Developer ID Application: /, '')}`;
  const found = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning']).toString().match(/"(Developer ID Application: [^"]+)"/);
  return found ? found[1] : '-';
}
