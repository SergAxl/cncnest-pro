const { app, BrowserWindow, shell } = require('electron')
const path = require('path')

// Отключить аппаратное ускорение если возникают проблемы с отрисовкой
// app.disableHardwareAcceleration()

function createWindow() {
  const win = new BrowserWindow({
    width:     1440,
    height:    900,
    minWidth:  1100,
    minHeight: 680,
    title:     'CNCnest PRO',
    backgroundColor: '#030c18',
    show: false, // показываем окно после загрузки (убирает белый мелк)
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      webSecurity:      true,
      // Разрешаем blob: URL для скачивания SVG/DXF/TXT
      allowRunningInsecureContent: false
    }
  })

  win.loadFile(path.join(__dirname, '../dist/index.html'))

  // Показать окно когда контент загружен
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  // Внешние ссылки открывать в браузере, не в Electron
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
