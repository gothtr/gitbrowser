const { app, BrowserWindow, ipcMain, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

const GITHUB_REPO = 'gothtr/gitbrowser';
const CURRENT_VERSION = app.isPackaged ? require('./package.json').version : '0.2.0';
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA || '', 'GitBrowser');

let win = null;

// ── Prevent multiple instances (fixes double window) ──
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 520,
    height: 580,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    backgroundColor: '#0a0e14',
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'app.ico')
      : path.join(__dirname, '..', 'resources', 'icons', 'app.ico'),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  win.loadFile(path.join(__dirname, 'installer.html'));
  win.once('ready-to-show', () => win.show());
  win.setMenu(null);
}

ipcMain.handle('get-icon-path', () => {
  if (app.isPackaged) return path.join(process.resourcesPath, 'logo-dark-text.png');
  return path.join(__dirname, '..', 'resources', 'icons', 'logo-dark-text.png');
});

ipcMain.handle('get-info', () => ({
  version: CURRENT_VERSION,
  installDir: INSTALL_DIR,
}));

ipcMain.handle('check-update', async () => {
  try {
    const resp = await net.fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'GitBrowser-Installer' } }
    );
    if (!resp.ok) return { latest: CURRENT_VERSION, download: null };
    const data = await resp.json();
    const tag = (data.tag_name || '').replace(/^v/, '');
    let downloadUrl = null;
    if (data.assets) {
      const exe = data.assets.find(a => a.name.match(/GitBrowser.*Setup.*\.exe$/i));
      if (exe) downloadUrl = exe.browser_download_url;
    }
    return { latest: tag, download: downloadUrl };
  } catch {
    return { latest: CURRENT_VERSION, download: null };
  }
});

// ── Install handler (non-blocking download + install) ──
ipcMain.handle('install', async (_e, { downloadUrl }) => {
  try {
    fs.mkdirSync(INSTALL_DIR, { recursive: true });

    if (downloadUrl) {
      // Use unique temp filename to avoid EBUSY conflicts
      const tmp = path.join(app.getPath('temp'), 'gitbrowser-setup-' + Date.now() + '.exe');

      // Clean up any leftover temp files from previous attempts
      try {
        const tempDir = app.getPath('temp');
        const oldFiles = fs.readdirSync(tempDir).filter(f => f.startsWith('gitbrowser-setup-') || f === 'gitbrowser-latest.exe');
        for (const f of oldFiles) {
          try { fs.unlinkSync(path.join(tempDir, f)); } catch {}
        }
      } catch {}

      // Download
      const resp = await net.fetch(downloadUrl);
      if (!resp.ok) throw new Error('Download failed: HTTP ' + resp.status);
      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(tmp, buffer);

      // Run installer in a child process (non-blocking, won't freeze UI)
      await new Promise((resolve, reject) => {
        const child = execFile(tmp, ['/S', '/D=' + INSTALL_DIR], { timeout: 300000 }, (err) => {
          // Clean up temp file
          try { fs.unlinkSync(tmp); } catch {}
          if (err) reject(new Error('Installer exited with error: ' + (err.message || err.code)));
          else resolve();
        });
        // If the child process is killed by timeout
        child.on('error', (err) => {
          try { fs.unlinkSync(tmp); } catch {}
          reject(err);
        });
      });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Shortcuts & registry (non-blocking) ──
ipcMain.handle('create-shortcuts', async () => {
  try {
    const exe = path.join(INSTALL_DIR, 'GitBrowser.exe');
    if (!fs.existsSync(exe)) return { ok: false, error: 'GitBrowser.exe not found' };
    const desktop = app.getPath('desktop');
    const startMenu = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');

    const runPS = (cmd) => new Promise((resolve) => {
      execFile('powershell', ['-NoProfile', '-Command', cmd], { timeout: 10000 }, (err) => resolve(!err));
    });

    const mkLnk = (lnkPath) => {
      // SEC-07: Use separate arguments to avoid PowerShell injection via path values
      const ps = [
        '-NoProfile', '-Command',
        '$s=(New-Object -COM WScript.Shell).CreateShortcut($args[0]);$s.TargetPath=$args[1];$s.WorkingDirectory=$args[2];$s.Save()',
        lnkPath, exe, INSTALL_DIR
      ];
      return new Promise((resolve) => {
        execFile('powershell', ps, { timeout: 10000 }, (err) => resolve(!err));
      });
    };

    await mkLnk(path.join(desktop, 'GitBrowser.lnk'));
    fs.mkdirSync(startMenu, { recursive: true });
    await mkLnk(path.join(startMenu, 'GitBrowser.lnk'));

    // Registry entry for Add/Remove Programs
    const rk = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GitBrowser';
    const regAdd = (name, value) => {
      return new Promise((resolve) => {
        execFile('reg', ['add', rk, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { timeout: 5000 }, () => resolve());
      });
    };
    await regAdd('DisplayName', 'GitBrowser');
    await regAdd('InstallLocation', INSTALL_DIR);
    await regAdd('DisplayIcon', exe);
    await regAdd('Publisher', 'gothtr');
    await regAdd('DisplayVersion', CURRENT_VERSION);
    await regAdd('UninstallString', `"${exe}" --uninstall`);
    await regAdd('URLInfoAbout', 'https://github.com/gothtr/gitbrowser');

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('launch-app', () => {
  const candidates = [
    path.join(INSTALL_DIR, 'GitBrowser.exe'),
    path.join(INSTALL_DIR, 'gitbrowser.exe'),
  ];

  for (const exe of candidates) {
    if (fs.existsSync(exe)) {
      try {
        spawn(exe, [], { detached: true, stdio: 'ignore', cwd: INSTALL_DIR }).unref();
      } catch {
        shell.openPath(exe);
      }
      setTimeout(() => app.quit(), 500);
      return { ok: true };
    }
  }

  shell.openPath(INSTALL_DIR);
  setTimeout(() => app.quit(), 500);
  return { ok: false, error: 'Executable not found' };
});

ipcMain.handle('close-installer', () => app.quit());

app.whenReady().then(() => {
  if (gotLock) createWindow();
});
app.on('window-all-closed', () => app.quit());
