const { app, BrowserWindow, ipcMain, net, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');

const GITHUB_REPO = 'gothtr/gitbrowser';
const CURRENT_VERSION = app.isPackaged ? require('./package.json').version : '0.1.0';
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA || '', 'GitBrowser');

let win = null;

function createWindow() {
  const size = 420;
  win = new BrowserWindow({
    width: size,
    height: size,
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
  if (app.isPackaged) return path.join(process.resourcesPath, 'icon.png');
  return path.join(__dirname, '..', 'resources', 'icons', 'logo-icon.png');
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
      if (!resp.ok) throw new Error('Download failed');
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
    if (!fs.existsSync(exe)) return { ok: false, error: 'Not found' };
    const desktop = app.getPath('desktop');
    const startMenu = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const mkLnk = (p) => {
      const ps = `$s=(New-Object -COM WScript.Shell).CreateShortcut('${p.replace(/'/g, "''")}');$s.TargetPath='${exe.replace(/'/g, "''")}';$s.WorkingDirectory='${INSTALL_DIR.replace(/'/g, "''")}';$s.Save()`;
      execSync(`powershell -NoProfile -Command "${ps}"`, { timeout: 10000 });
    };
    mkLnk(path.join(desktop, 'GitBrowser.lnk'));
    mkLnk(path.join(startMenu, 'GitBrowser.lnk'));
    const rk = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GitBrowser';
    execSync(`reg add "${rk}" /v DisplayName /t REG_SZ /d "GitBrowser" /f`, { timeout: 5000 });
    execSync(`reg add "${rk}" /v InstallLocation /t REG_SZ /d "${INSTALL_DIR}" /f`, { timeout: 5000 });
    execSync(`reg add "${rk}" /v DisplayIcon /t REG_SZ /d "${exe}" /f`, { timeout: 5000 });
    execSync(`reg add "${rk}" /v Publisher /t REG_SZ /d "gothtr" /f`, { timeout: 5000 });
    execSync(`reg add "${rk}" /v DisplayVersion /t REG_SZ /d "${CURRENT_VERSION}" /f`, { timeout: 5000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('launch-app', () => {
  const exe = path.join(INSTALL_DIR, 'GitBrowser.exe');
  if (fs.existsSync(exe)) spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
});

ipcMain.handle('close-installer', () => app.quit());

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
