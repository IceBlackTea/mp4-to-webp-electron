const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
// const ffmpegPath = require('ffmpeg-static');
function getFFmpegPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe');
  }
  return require('ffmpeg-static');
}
const ffmpegPath = getFFmpegPath();

const logPath = path.join(process.cwd(), 'debug.log');

function log(...args) {
  fs.appendFileSync(logPath, args.join(' ') + '\n');
  console.log(args);
}

process.on('uncaughtException', (err) => {
  log('uncaughtException:', err);
});

process.on('unhandledRejection', (err) => {
  log('unhandledRejection:', err);
});

log("cwd=", process.cwd());
log("__dirname=", __dirname);
log("resourcesPath=", process.resourcesPath);
log("userData=", app.getPath("userData"));
log("ffmpegPath=", ffmpegPath);

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

// Keep a global reference of the window object to avoid garbage collection
let mainWindow;

function createWindow() {
  // Create the browser window with modern design aesthetics
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 600,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: true,
      additionalArguments: ['--disable-features=OutOfBlinkCors'],
      allowRunningInsecureContent: false
    },
    frame: false, // Frameless window for modern look
    transparent: true, // Support transparency
    titleBarStyle: 'hidden', // Hide default title bar
    roundedCorners: true, // Round corners for modern look
    backgroundColor: '#00000000', // Transparent background
    show: false, // Don't show until ready
  });

  // Enable file dropping on the window
  mainWindow.webContents.on('will-navigate', (e) => {
    e.preventDefault();
  });

  // Load the app interface
  mainWindow.loadFile('index.html');

  // Show window when ready to avoid flashing
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Emitted when the window is closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Create window when app is ready
app.whenReady().then(createWindow);

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// On macOS re-create window when dock icon is clicked and no windows are open
app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

// Handle window control events
ipcMain.on('window-minimize', () => {
  mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.on('window-close', () => {
  mainWindow.close();
});

// Handle file drops
ipcMain.handle('file-drop', async (event, filePaths, settings) => {
  return processFiles(filePaths, settings);
});

// Handle video dimensions request
ipcMain.handle('get-video-dimensions', async (event, filePath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        log('Error getting video dimensions:', err);
        reject(err);
        return;
      }

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      if (!videoStream) {
        reject(new Error('No video stream found'));
        return;
      }

      resolve({
        width: videoStream.width,
        height: videoStream.height
      });
    });
  });
});

// Handle file dialog open
ipcMain.handle('select-files', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Videos', extensions: ['mp4', 'mov', 'avi'] }
    ]
  });

  if (!canceled) {
    return processFiles(filePaths);
  }
  return { success: false, message: 'File selection canceled' };
});

// Process files for conversion
async function processFiles(filePaths, settings = {}) {
  // Validate input
  if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
    log('Invalid file paths received:', filePaths);
    return { success: false, message: 'No valid files to process' };
  }
  
  const results = [];
  let completed = 0;
  
  // Default settings
  const defaultSettings = {
    quality: 75,
    lossless: false,
    compressionLevel: 6,
    preset: 'default',
    scale: 100
  };

  // Merge provided settings with defaults
  const finalSettings = { ...defaultSettings, ...settings };
  
  for (const filePath of filePaths) {
    // Skip invalid file paths
    if (!filePath || typeof filePath !== 'string') {
      log('Invalid file path, skipping:', filePath);
      continue;
    }
    
    const fileInfo = path.parse(filePath);
    const outputPath = path.join(fileInfo.dir, `${fileInfo.name}.webp`);
    
    // Send start progress event
    mainWindow.webContents.send('conversion-progress', {
      file: fileInfo.base,
      progress: 0,
      currentFile: completed + 1,
      totalFiles: filePaths.length
    });

    try {
      await new Promise((resolve, reject) => {
        // Create the ffmpeg command with settings
        const command = ffmpeg(filePath)
          .size('720x?') // 导出宽度720的图
          .outputFormat('webp')
          .noAudio() // WebP typically doesn't support audio
          .videoCodec('libwebp');

        // Apply scale if not 100%
        // if (finalSettings.scale !== 100) {
        //   command.videoFilters([{
        //     filter: 'scale',
        //     options: `iw*${finalSettings.scale/100}:ih*${finalSettings.scale/100}`
        //   }]);
        // }

        command.videoFilters([
          // {
          //   filter: 'scale',
          //   options: 'iw*0.5:ih*0.5'
          // },
          {
            filter: 'fps',
            options: '12'
          }
        ]);

        

        command
          .addOutputOption(`-quality ${finalSettings.quality}`)
          .addOutputOption(`-lossless ${finalSettings.lossless ? 1 : 0}`)
          .addOutputOption(`-compression_level ${finalSettings.compressionLevel}`)
          .addOutputOption(`-preset ${finalSettings.preset}`)
          .addOutputOption('-loop 0') // 循环播放
          .output(outputPath);
          // .output(path.join(fileInfo.dir, "frame_%04d.webp"))

        // Add progress handler
        let lastProgressTime = Date.now();
        let fakeProgess = 0;
        
        command.on('progress', (progress) => {
          // Throttle progress updates to avoid overwhelming the UI
          const now = Date.now();
          if (now - lastProgressTime > 100 || progress.percent >= 100) {
            lastProgressTime = now;

            if (isNaN(progress.percent)) {

              if (fakeProgess < 95) {
                fakeProgess = fakeProgess + 5;
              }
              // Update progress in UI
              mainWindow.webContents.send('conversion-progress', {
                file: fileInfo.base,
                progress: fakeProgess,
                currentFile: completed + 1,
                totalFiles: filePaths.length
              });
              
              // Log progress to console for debugging
              log(`Progress: ${fakeProgess}% done`);

            } else {
            
              // Update progress in UI
              mainWindow.webContents.send('conversion-progress', {
                file: fileInfo.base,
                progress: Math.floor(progress.percent),
                currentFile: completed + 1,
                totalFiles: filePaths.length
              });
              
              // Log progress to console for debugging
              log(`Progress: ${Math.floor(progress.percent)}% done`);
            }
          }
        });
        
        command.on('end', () => {
          // Ensure 100% progress is shown
          mainWindow.webContents.send('conversion-progress', {
            file: fileInfo.base,
            progress: 100,
            currentFile: completed + 1,
            totalFiles: filePaths.length
          });
          
          completed++;
          results.push({
            input: filePath,
            output: outputPath,
            success: true
          });
          log(`Finished processing ${filePath}`);
          resolve();
        });

        command.on('error', (err) => {
          log(`Error during conversion: ${err.message}`);
          completed++;
          results.push({
            input: filePath,
            error: err.message,
            success: false
          });
          reject(err);
        });
        
        // Run the command
        command.run();
      }).catch(err => log(`Error converting ${filePath}:`, err));
    } catch (error) {
      log(`Error processing ${filePath}:`, error);
    }
  }
  
  // Conversion complete
  mainWindow.webContents.send('conversion-complete', results);
  return { success: true, results };
}