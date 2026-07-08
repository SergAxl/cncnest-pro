const { app, BrowserWindow, shell } = require('electron')
const path = require('path')
function createWindow() {
  const win = new BrowserWindow({
    width:1440,height:900,minWidth:1100,minHeight:680,
    title:'CNCnest PRO',backgroundColor:'#030c18',show:false,
    webPreferences:{nodeIntegration:false,contextIsolation:true}
  })
  win.loadFile(path.join(__dirname,'../dist/index.html'))
  win.once('ready-to-show',()=>{win.show();win.focus()})
  win.webContents.setWindowOpenHandler(({url})=>{shell.openExternal(url);return{action:'deny'}})
}
app.whenReady().then(()=>{
  createWindow()
  app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow()})
})
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()})
