const { app, BrowserWindow, ipcMain, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');

const GITHUB_REPO = 'gothtr/gitbrowser';
const CURRENT_VERSION = app.isPackaged ? require('./package.json').version : '0.1.0';
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA || '', 'GitBrowser');

let win = null;

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

ipcMain.handle('install', async (_e, { downloadUrl }) => {
  try {
    fs.mkdirSync(INSTALL_DIR, { recursive: true });

    if (downloadUrl) {
      const tmp = path.join(app.getPath('temp'), 'gitbrowser-latest.exe');
      const resp = await net.fetch(downloadUrl);
      if (!resp.ok) throw new Error('Download failed: ' + resp.status);
      fs.writeFileSync(tmp, Buffer.from(await resp.arrayBuffer()));
      execSync(`"${tmp}" /S /D=${INSTALL_DIR}`, { timeout: 180000 });
      try { fs.unlinkSync(tmp); } catch {}
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('create-shortcuts', async () => {
  try {
    const exe = path.join(INSTALL_DIR, 'GitBrowser.exe');
    if (!fs.existsSync(exe)) return { ok: false, error: 'GitBrowser.exe not found in ' + INSTALL_DIR };
    const desktop = app.getPath('desktop');
    const startMenu = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');

    const mkLnk = (lnkPath) => {
      const ps = `$s=(New-Object -COM WScript.Shell).CreateShortcut('${lnkPath.replace(/'/g, "''")}');$s.TargetPath='${exe.replace(/'/g, "''")}';$s.WorkingDirectory='${INSTALL_DIR.replace(/'/g, "''")}';$s.Save()`;
      execSync(`powershell -NoProfile -Command "${ps}"`, { timeout: 10000 });
    };
    mkLnk(path.join(desktop, 'GitBrowser.lnk'));
    fs.mkdirSync(startMenu, { recursive: true });
    mkLnk(path.join(startMenu, 'GitBrowser.lnk'));

    // Registry entry for Add/Remove Programs
    const rk = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GitBrowser';
    const regAdd = (name, value) => {
      try { execSync(`reg add "${rk}" /v ${name} /t REG_SZ /d "${value}" /f`, { timeout: 5000 }); } catch {}
    };
    regAdd('DisplayName', 'GitBrowser');
    regAdd('InstallLocation', INSTALL_DIR);
    regAdd('DisplayIcon', exe);
    regAdd('Publisher', 'gothtr');
    regAdd('DisplayVersion', CURRENT_VERSION);
    regAdd('UninstallString', `"${exe}" --uninstall`);
    regAdd('URLInfoAbout', 'https://github.com/gothtr/gitbrowser');

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('launch-app', () => {
  // Try multiple possible exe locations
  const candidates = [
    path.join(INSTALL_DIR, 'GitBrowser.exe'),
    path.join(INSTALL_DIR, 'gitbrowser.exe'),
  ];

  for (const exe of candidates) {
    if (fs.existsSync(exe)) {
      try {
        spawn(exe, [], { detached: true, stdio: 'ignore', cwd: INSTALL_DIR }).unref();
        setTimeout(() => app.quit(), 500);
        return { ok: true };
      } catch (e) {
        // Try shell.openPath as fallback
        shell.openPath(exe);
        setTimeout(() => app.quit(), 500);
        return { ok: true };
      }
    }
  }

  // Fallback: open install directory
  shell.openPath(INSTALL_DIR);
  setTimeout(() => app.quit(), 500);
  return { ok: false, error: 'Executable not found' };
});

ipcMain.handle('close-installer', () => app.quit());

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
