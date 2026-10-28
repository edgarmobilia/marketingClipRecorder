// Builds a portable Windows folder (and a .zip) to hand the desktop app to
// someone else: the app, the editor and the Claude MCP server in one place.
//
//   npm run package   →   dist/Marketing Clip Recorder-win32-x64/ + .zip
//
// Nothing needs to be installed on the other machine except Claude Code: the
// app's own executable runs the MCP server as Node (ELECTRON_RUN_AS_NODE), and
// "Conectar con Claude.cmd" registers it. Whisper models are not bundled; the
// first transcription downloads one into %LOCALAPPDATA%.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(DESKTOP, '..');
const DIST = path.join(DESKTOP, 'dist');
const STAGE = path.join(DIST, 'stage');
const NAME = 'Marketing Clip Recorder';

const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
const electronVersion = require('electron/package.json').version;

const copy = (from, to, filter) => fs.cpSync(from, to, { recursive: true, dereference: true, filter });
const rel = p => p.split(path.sep).join('/');

// --- Stage: the app folder exactly as it will ship ---
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

for (const f of ['main.js', 'events.js', 'ffmpeg-capture.js', 'preload.js', 'recorder']) {
  copy(path.join(DESKTOP, f), path.join(STAGE, 'desktop', f));
}
// Runtime dependencies of the desktop app (the global input hook)
for (const m of ['uiohook-napi', 'node-gyp-build']) {
  copy(path.join(DESKTOP, 'node_modules', m), path.join(STAGE, 'desktop', 'node_modules', m));
}
copy(path.join(REPO, 'editor'), path.join(STAGE, 'editor'));
copy(path.join(REPO, 'icons'), path.join(STAGE, 'icons'));

// MCP server with its node_modules, minus what Windows x64 never loads and
// any Whisper models downloaded on this machine
const SKIP = [
  '/@huggingface/transformers/.cache',
  '/onnxruntime-node/bin/napi-v6/darwin',
  '/onnxruntime-node/bin/napi-v6/linux',
  '/onnxruntime-node/bin/napi-v6/win32/arm64',
  '/node_modules/.bin',
];
for (const f of ['server.js', 'transcribe.js', 'package.json']) copy(path.join(REPO, 'mcp', f), path.join(STAGE, 'mcp', f));
copy(path.join(REPO, 'mcp', 'node_modules'), path.join(STAGE, 'mcp', 'node_modules'),
  src => !SKIP.some(s => rel(src).endsWith(s) || rel(src).includes(s + '/')));

fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify({
  name: pkg.name, productName: NAME, version: pkg.version, description: pkg.description,
  main: 'desktop/main.js', license: pkg.license,
}, null, 2));

// --- Icon (.ico from the PNG, if ffmpeg is around) ---
let icon;
const ico = path.join(DIST, 'icon.ico');
const ff = spawnSync(process.env.MCR_FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-i', path.join(REPO, 'icons', 'icon128.png'), ico]);
if (ff.status === 0) icon = ico;
else console.warn('ffmpeg not found: the .exe keeps the default Electron icon');

// --- Package ---
const mod = await import('@electron/packager');
const packager = mod.packager || mod.default;
const [outDir] = await packager({
  dir: STAGE,
  out: DIST,
  name: NAME,
  platform: 'win32',
  arch: 'x64',
  electronVersion,
  asar: false,        // the MCP server runs from these files with the app's own Node
  prune: false,       // node_modules above are hand-picked
  overwrite: true,
  icon,
  appVersion: pkg.version,
  win32metadata: { ProductName: NAME, FileDescription: NAME, CompanyName: 'Marketing Clip Recorder' },
});

// --- Claude Code hook-up + read-me ---
const crlf = s => s.replace(/\r?\n/g, '\r\n');
fs.writeFileSync(path.join(outDir, 'Conectar con Claude.cmd'), crlf(`@echo off
setlocal
rem Registers the clip editor MCP server in Claude Code (user scope), run by
rem this app's own executable as Node. Run it again if you move this folder.
set "APP=%~dp0${NAME}.exe"
set "SERVER=%~dp0resources\\app\\mcp\\server.js"
where claude >nul 2>nul
if errorlevel 1 (
  echo No se encuentra Claude Code. Instalalo primero: https://claude.com/claude-code
  pause
  exit /b 1
)
call claude mcp remove clip-editor -s user >nul 2>nul
call claude mcp add clip-editor -s user -e ELECTRON_RUN_AS_NODE=1 -e "MCR_MODEL_CACHE=%LOCALAPPDATA%\\MarketingClipRecorder\\models" -- "%APP%" "%SERVER%"
if errorlevel 1 (
  echo No se pudo registrar el servidor en Claude Code.
  pause
  exit /b 1
)
echo.
echo Listo. Abre (o reinicia) Claude Code y la app; el editor mostrara "Claude: connected".
pause
`));

fs.writeFileSync(path.join(outDir, 'LEEME.txt'), crlf(`${NAME} ${pkg.version}

1. Descomprime esta carpeta donde quieras (por ejemplo en Documentos) y no la muevas despues.
2. Abre "${NAME}.exe": graba la pantalla, o pulsa "Abrir video..." para editar un video que ya tengas.
3. Para editar con Claude: instala Claude Code (https://claude.com/claude-code) y ejecuta una vez
   "Conectar con Claude.cmd". Despues abre Claude Code: con el editor abierto, pidele cosas como
   "anade subtitulos al video", "corta los tiempos muertos" o "haz una version vertical para TikTok".
   Si mueves la carpeta, vuelve a ejecutar "Conectar con Claude.cmd".

Notas
- Subtitulos: la primera transcripcion descarga el modelo de voz (unos 250 MB), luego funciona sin internet.
- "Grabar sin el cursor de Windows" necesita ffmpeg: winget install Gyan.FFmpeg
- Los videos exportados se guardan en Videos\\${NAME}.
`));

// --- Zip (Windows' bsdtar writes zip archives) ---
const zip = path.join(DIST, `${path.basename(outDir)}.zip`);
const tar = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),
  ['-a', '-cf', zip, '-C', DIST, path.basename(outDir)], { stdio: 'inherit' });
fs.rmSync(STAGE, { recursive: true, force: true });
console.log(`\nApp: ${outDir}`);
console.log(tar.status === 0 ? `Zip: ${zip}` : 'Zip failed; share the folder instead');
