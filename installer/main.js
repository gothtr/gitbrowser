const { app, BrowserWindow, ipcMain, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');

const GITHUB_REPO = 'gothtr/gitbrowser';
const CURRENT_VERSION = '0.1.0';
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'GitBrowser');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 380,
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    icon: path.join(process.resourcesPath || __dirname, 'app.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  win.loadFile(path.join(__dirname, 'installer.html'));
  win.once('ready-to-show', () => win.show());
  win.setMenu(null);
}

// ─── IPC ───

ipcMain.handle('get-info', () => ({
  version: CURRENT_VERSION,
  installDir: INSTALL_DIR,
  repo: GITHUB_REPO,
}));

ipcMain.handle('check-update', async () => {
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    const resp = await net.fetch(url, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'GitBrowser-Installer' },
    });
    if (!resp.ok) return { latest: CURRENT_VERSION, download: null };
    const data = await resp.json();
    const tag = (data.tag_name || '').replace(/^v/, '');
    // Find .exe asset (the main app zip or nsis installer)
    let downloadUrl = null;
    if (data.assets) {
      // Prefer the zip/portable package
      const zipAsset = data.assets.find(a => a.name.endsWith('.zip') || a.name.includes('win'));
      if (zipAsset) downloadUrl = zipAsset.browser_download_url;
      // Fallback to any .exe
      if (!downloadUrl) {
        const exeAsset = data.assets.find(a => a.name.endsWith('.exe'));
        if (exeAsset) downloadUrl = exeAsset.browser_download_url;
      }
    }
    return { latest: tag, download: downloadUrl };
  } catch (e) {
    return { latest: CURRENT_VERSION, download: null, error: e.message };
  }
});

ipcMain.handle('install', async (_e, { downloadUrl }) => {
  try {
    // Create install directory
    if (!fs.existsSync(INSTALL_DIR)) {
      fs.mkdirSync(INSTALL_DIR, { recursive: true });
    }

    // If we have a download URL, fetch the latest release
    if (downloadUrl) {
      const tmpFile = path.join(app.getPath('temp'), 'gitbrowser-update.exe');
      const resp = await net.fetch(downloadUrl);
      if (!resp.ok) throw new Error('Download failed: ' + resp.status);
      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(tmpFile, buffer);

      // If it's an NSIS installer, run it silently
      if (tmpFile.endsWith('.exe')) {
        execSync(`"${tmpFile}" /S /D=${INSTALL_DIR}`, { timeout: 120000 });
        try { fs.unlinkSync(tmpFile); } catch {}
        return { ok: true };
      }
    }

    // Fallback: copy current app files (self-contained install)
    // The main app files should be bundled alongside this installer
    // or downloaded from the release
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('create-shortcuts', async () => {
  try {
    const exePath = path.join(INSTALL_DIR, 'GitBrowser.exe');
    if (!fs.existsSync(exePath)) return { ok: false, error: 'App not found' };

    // Desktop shortcut via PowerShell
    const desktopDir = app.getPath('desktop');
    const startMenuDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');

    const createShortcut = (lnkPath) => {
      const ps = `$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('${lnkPath.replace(/'/g, "''")}'); $s.TargetPath = '${exePath.replace(/'/g, "''")}'; $s.WorkingDirectory = '${INSTALL_DIR.replace(/'/g, "''")}'; $s.Save()`;
      execSync(`powershell -NoProfile -Command "${ps}"`, { timeout: 10000 });
    };

    createShortcut(path.join(desktopDir, 'GitBrowser.lnk'));
    createShortcut(path.join(startMenuDir, 'GitBrowser.lnk'));

    // Write uninstall registry entry
    const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GitBrowser';
    execSync(`reg add "${regKey}" /v DisplayName /t REG_SZ /d "GitBrowser" /f`, { timeout: 5000 });
    execSync(`reg add "${regKey}" /v InstallLocation /t REG_SZ /d "${INSTALL_DIR}" /f`, { timeout: 5000 });
    execSync(`reg add "${regKey}" /v DisplayIcon /t REG_SZ /d "${exePath}" /f`, { timeout: 5000 });
    execSync(`reg add "${regKey}" /v Publisher /t REG_SZ /d "gothtr" /f`, { timeout: 5000 });
    execSync(`reg add "${regKey}" /v DisplayVersion /t REG_SZ /d "${CURRENT_VERSION}" /f`, { timeout: 5000 });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('launch-app', () => {
  const exePath = path.join(INSTALL_DIR, 'GitBrowser.exe');
  if (fs.existsSync(exePath)) {
    spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref();
  }
  app.quit();
});

ipcMain.handle('close-installer', () => {
  app.quit();
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
