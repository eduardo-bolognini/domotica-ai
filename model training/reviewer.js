const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const fse = require("fs-extra");
const path = require("path");
const csv = require("csv-parser");
const moment = require("moment");

// ========================================
// CONFIGURATION (SAVED IN config.json)
// ========================================

const CONFIG_FILE = path.join(__dirname, "config_server (ignore).json");

// Default configuration
const DEFAULT_CONFIG = {
  BASE_FOLDER: "clusters_kmeans_500_multi",
  CSV_FILE: null,
  GROUP_MODE: false,
  ANNOTATIONS_ENABLED: true,
  actionParams: {
    turn_on: [
      ["camera"],
      ["bed", "desk", "lamp", "monitor"]
    ],
    turn_off: [
      ["camera"],
      ["bed", "desk", "lamp", "monitor"]
    ],
    turn_off_all: [
      ["camera"]
    ]
  }
};

// Load configuration from file or use default
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      console.log('📋 Configuration loaded from file:', configData);
      return { ...DEFAULT_CONFIG, ...configData };
    }
  } catch (error) {
    console.warn('Error loading config, using default:', error.message);
  }
  console.log('📋 Using default configuration');
  return DEFAULT_CONFIG;
}

// Save configuration
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    console.log('💾 Configuration saved:', config);
    return true;
  } catch (error) {
    console.error('Error saving config:', error);
    return false;
  }
}

let CONFIG = loadConfig();
console.log('🔧 Active configuration:', CONFIG);

// ========================================
// INITIALIZATION
// ========================================

const app = express();
const PORT = 3000;

let ACTIONS = Object.keys(CONFIG.actionParams);
let PATHS = {};
let csvData = [];
let csvTimestamps = [];

function updatePaths() {
  const csvPath = CONFIG.CSV_FILE ? 
    (path.isAbsolute(CONFIG.CSV_FILE) ? CONFIG.CSV_FILE : path.join(__dirname, CONFIG.CSV_FILE)) 
    : null;
    
  PATHS = {
    base: path.join(__dirname, CONFIG.BASE_FOLDER),
    annotations: path.join(__dirname, "annotations.json"),
    csv: csvPath,
    descriptions: path.join(__dirname, "descriptions.csv"),
    undefined: path.join(__dirname, CONFIG.BASE_FOLDER, "undefined"),
    indefinite: path.join(__dirname, "indefinite"),
    movementLog: path.join(__dirname, "movement_log.json")
  };
  ACTIONS = Object.keys(CONFIG.actionParams);
  
  console.log('📁 PATHS updated:', {
    base: PATHS.base,
    csv: PATHS.csv,
    csvExists: PATHS.csv ? fs.existsSync(PATHS.csv) : 'N/A'
  });
}

// Call updatePaths immediately after loading the configuration
updatePaths();

// ========================================
// CSV DATA LOADING
// ========================================

function loadCSVData() {
  return new Promise((resolve, reject) => {
    // Reset data
    csvData = [];
    csvTimestamps = [];
    
    console.log(`📊 Attempting to load CSV: ${PATHS.csv}`);
    
    if (!PATHS.csv || !fs.existsSync(PATHS.csv)) {
      console.warn(`⚠️ CSV file not configured or not found: ${PATHS.csv}`);
      console.warn(`   - PATHS.csv: ${PATHS.csv}`);
      console.warn(`   - Exists: ${PATHS.csv ? fs.existsSync(PATHS.csv) : 'N/A'}`);
      return resolve();
    }

    console.log(`✅ CSV file found, starting read...`);
    
    let rowCount = 0;
    let successfulRows = 0;
    let errorRows = 0;

    const stream = fs.createReadStream(PATHS.csv)
      .pipe(csv())
      .on('data', (row) => {
        rowCount++;
        
        if (rowCount <= 3) {
          console.log(`🔍 Row ${rowCount} sample:`, Object.keys(row).slice(0, 5), '...');
        }
        
        const timestamp = row.timestamp;
        if (!timestamp) {
          if (errorRows < 3) {
            console.log(`⚠️ Row ${rowCount} without timestamp:`, Object.keys(row));
          }
          errorRows++;
          return;
        }
        
        const timeValue = moment(timestamp, "YYYY-MM-DD HH:mm:ss.SSSSSS").valueOf();
        
        if (!isNaN(timeValue)) {
          csvData.push({ timestamp, row, timeValue });
          csvTimestamps.push(timeValue);
          successfulRows++;
        } else {
          if (errorRows < 3) {
            console.log(`⚠️ Invalid timestamp at row ${rowCount}: "${timestamp}"`);
          }
          errorRows++;
        }
      })
      .on('end', () => {
        csvData.sort((a, b) => a.timeValue - b.timeValue);
        csvTimestamps = csvData.map(item => item.timeValue);
        
        console.log(`📊 CSV loading complete:`);
        console.log(`   - Total rows read: ${rowCount}`);
        console.log(`   - Valid rows:${successfulRows}`);
        console.log(`   - Rows with errors:${errorRows}`);
        console.log(`   - Final data: ${csvData.length} rows`);
        
        if (csvData.length > 0) {
          console.log(`   - First row timestamp: ${csvData[0].timestamp}`);
          console.log(`   - Last row timestamp: ${csvData[csvData.length-1].timestamp}`);
          console.log(`   - Available columns:`, Object.keys(csvData[0].row).slice(0, 10).join(', '));
        }
        
        resolve();
      })
      .on('error', (error) => {
        console.error(`❌ Error while reading CSV:`, error);
        reject(error);
      });
  });
}

// ========================================
// NUOVE FUNZIONI PER SELEZIONE MULTIPLA
// ========================================

function loadMovementLog() {
  if (!fs.existsSync(PATHS.movementLog)) return [];
  try {
    const data = fs.readFileSync(PATHS.movementLog, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Errore nel caricamento log movimenti:', error);
    return [];
  }
}

function saveMovementLog(movements) {
  try {
    let log = loadMovementLog();
    log.push({
      timestamp: new Date().toISOString(),
      movements: movements
    });
    fs.writeFileSync(PATHS.movementLog, JSON.stringify(log, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Errore nel salvare log movimenti:', error);
    return false;
  }
}

function moveMultipleToUndefined(folder, items) {
  const movements = {};
  let successCount = 0;
  
  try {
    fse.ensureDirSync(PATHS.undefined);
    
    for (const item of items) {
      try {
        const sourcePath = path.join(PATHS.base, folder, item);
        const targetPath = path.join(PATHS.undefined, item);
        
        if (fs.existsSync(sourcePath)) {
          fse.moveSync(sourcePath, targetPath, { overwrite: true });
          movements[`${CONFIG.BASE_FOLDER}/${folder}/${item}`] = `undefined/${item}`;
          successCount++;
        }
      } catch (error) {
        console.error(`Error moving ${item}:`, error);
      }
    }
    
    if (Object.keys(movements).length > 0) {
      saveMovementLog(movements);
    }
    
    return { success: true, moved: successCount, total: items.length };
  } catch (error) {
    console.error('Errore in moveMultipleToUndefined:', error);
    return { success: false, error: error.message };
  }
}

function moveToCluster(sourceFolder, targetFolder, items, createIfNotExists = false) {
  return moveToClusterExtended(sourceFolder, targetFolder, items, createIfNotExists);
}

function getClusterPreviews() {
  const clusters = getAllClusters();
  const previews = [];
  
  for (const cluster of clusters) {
    try {
      const clusterPath = path.join(PATHS.base, cluster);
      let previewImage = null;
      
      if (CONFIG.GROUP_MODE) {
        const groups = fs.readdirSync(clusterPath, { withFileTypes: true })
          .filter(dirent => dirent.isDirectory())
          .map(dirent => dirent.name);
        
        for (const group of groups) {
          const groupPath = path.join(clusterPath, group);
          const images = fs.readdirSync(groupPath).filter(isImageFile);
          if (images.length > 0) {
            previewImage = `/clusters/${cluster}/${group}/${images[0]}`;
            break;
          }
        }
      } else {
        const images = fs.readdirSync(clusterPath).filter(isImageFile);
        if (images.length > 0) {
          previewImage = `/clusters/${cluster}/${images[0]}`;
        }
      }
      
      if (previewImage) {
        previews.push({
          name: cluster,
          preview: previewImage
        });
      }
    } catch (error) {
      console.error(`Error getting preview for ${cluster}:`, error);
    }
  }
  
  return previews;
}8

// ========================================
// MIDDLEWARE
// ========================================

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Middleware dinamico per static files che si aggiorna quando cambiano i PATHS
app.use('/clusters', (req, res, next) => {
  console.log(`🖼️ Image request: ${req.url}`);
  console.log(`📁 PATHS.base: ${PATHS.base}`);
  console.log(`📁 Full path: ${path.join(PATHS.base, req.url)}`);
  
  // Usa express.static con il path base attuale
  const staticMiddleware = express.static(PATHS.base);
  staticMiddleware(req, res, (err) => {
    if (err) {
      console.log(`❌ Error serving file: ${err.message}`);
      res.status(404).send('Immagine non trovata');
    } else {
      next();
    }
  });
});

app.use('/indefinite', (req, res, next) => {
  console.log(`🖼️ Indefinite request: ${req.url}`);
  const staticMiddleware = express.static(PATHS.indefinite);
  staticMiddleware(req, res, (err) => {
    if (err) {
      console.log(`❌ Indefinite error: ${err.message}`);
      res.status(404).send('File indefinite non trovato');
    } else {
      next();
    }
  });
});

// ========================================
// UTILITY FUNCTIONS
// ========================================

function convertFilenameToCSVTimestamp(filename) {
  const [datePart, timePart] = filename.split('_');
  const [day, month] = datePart.split('-');
  const [hour, minute, second] = timePart.split('-');
  return `2025-${month}-${day} ${hour}:${minute}:${second}.000000`;
}

function findClosestCSVRow(fileTimestamp) {
  if (csvData.length === 0) return null;
  
  const fileTime = moment(fileTimestamp, "YYYY-MM-DD HH:mm:ss.SSSSSS").valueOf();
  
  let left = 0;
  let right = csvTimestamps.length - 1;
  let closestIndex = 0;
  let smallestDiff = Math.abs(csvTimestamps[0] - fileTime);

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const diff = Math.abs(csvTimestamps[mid] - fileTime);
    
    if (diff < smallestDiff) {
      smallestDiff = diff;
      closestIndex = mid;
    }
    
    if (csvTimestamps[mid] < fileTime) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return smallestDiff <= 300000 ? csvData[closestIndex].row : null;
}

// Modifica la funzione getDescribedFolders esistente per considerare i cluster saltati
function getDescribedFolders() {
  const described = new Set();
  
  // Aggiungi cluster descritti dal file descriptions.csv
  if (fs.existsSync(PATHS.descriptions)) {
    const content = fs.readFileSync(PATHS.descriptions, 'utf8').trim();
    if (content) {
      const lines = content.split("\n").slice(1); // Salta header
      lines.forEach(line => {
        const folder = line.split(',')[0];
        if (folder) described.add(folder);
      });
    }
  }
  
  return described;
}

// Nuova funzione per ottenere cluster che devono essere saltati nella review
function getProcessedFolders() {
  const processed = new Set();
  
  // Aggiungi cluster descritti
  const described = getDescribedFolders();
  described.forEach(folder => processed.add(folder));
  
  // Aggiungi cluster saltati
  const skipped = loadSkippedClusters();
  skipped.forEach(folder => processed.add(folder));
  
  return processed;
}

function getTopDescriptions() {
  if (!fs.existsSync(PATHS.descriptions)) return [];
  const lines = fs.readFileSync(PATHS.descriptions, "utf8").trim().split("\n").slice(1);
  const count = {};
  for (const line of lines) {
    const desc = line.split(",")[1]?.trim();
    if (!desc) continue;
    count[desc] = (count[desc] || 0) + 1;
  }
  return Object.entries(count)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([desc]) => desc);
}

function saveCsv(folder, desc) {
  let rows = [];
  if (fs.existsSync(PATHS.descriptions)) {
    const content = fs.readFileSync(PATHS.descriptions, "utf8").trim().split("\n").slice(1);
    rows = content
      .map(line => { const [f, d] = line.split(","); return { folder: f, description: d }; })
      .filter(r => r.folder !== folder);
  }
  rows.push({ folder, description: desc });
  const header = "folder,description\n";
  const data = rows.map(r => `${r.folder},${r.description}`).join("\n");
  fs.writeFileSync(PATHS.descriptions, header + data, "utf8");
}

function loadAnnotations() {
  if (!CONFIG.ANNOTATIONS_ENABLED || !fs.existsSync(PATHS.annotations)) return [];
  
  try {
    const data = fs.readFileSync(PATHS.annotations, 'utf8');
    return data.trim() ? JSON.parse(data) : [];
  } catch (error) {
    console.error('Errore nel caricamento annotazioni:', error);
    return [];
  }
}

function saveAnnotations(data) {
  if (!CONFIG.ANNOTATIONS_ENABLED) return;
  
  try {
    fs.writeFileSync(PATHS.annotations, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Errore nel salvataggio annotazioni:', error);
    throw error;
  }
}

function getAllClusters() {
  try {
    console.log(`🔍 Searching for clusters in: ${PATHS.base}`);
    console.log(`📁 Does the folder exist? ${fs.existsSync(PATHS.base)}`);
    
    if (!fs.existsSync(PATHS.base)) {
      console.log(`❌ Folder not found: ${PATHS.base}`);
      return [];
    }
    
    const allItems = fs.readdirSync(PATHS.base, { withFileTypes: true });
    console.log(`📂 All items found:`, allItems.map(item => `${item.name} (${item.isDirectory() ? 'DIR' : 'FILE'})`));
    
    const clusters = allItems
      .filter(dirent => {
        const isDir = dirent.isDirectory();
        const startsWithCluster = dirent.name.startsWith("cluster_");
        console.log(`📋 ${dirent.name}: isDirectory=${isDir}, startsWithCluster=${startsWithCluster}`);
        return isDir && startsWithCluster;
      })
      .map(dirent => dirent.name);
    
    console.log(`✅ Clusters found:`, clusters);
    return clusters;
  } catch (error) {
    console.error('❌ Errore nel leggere i cluster:', error);
    return [];
  }
}

function getAllFolders() {
  try {
    return fs.readdirSync(__dirname, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('.') && !dirent.name.includes('node_modules'))
      .map(dirent => dirent.name);
  } catch (error) {
    console.error('Errore nel leggere le cartelle:', error);
    return [];
  }
}

function getAllCSVFiles() {
  try {
    const csvFiles = [];
    
    // Cerca nella cartella corrente
    const currentDirFiles = fs.readdirSync(__dirname)
      .filter(file => file.endsWith('.csv'))
      .map(file => ({ name: file, path: file, location: 'Cartella corrente' }));
    
    csvFiles.push(...currentDirFiles);
    
    // Cerca nelle sottocartelle (un livello)
    const subDirs = fs.readdirSync(__dirname, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('.') && !dirent.name.includes('node_modules'))
      .map(dirent => dirent.name);
    
    for (const subDir of subDirs) {
      try {
        const subDirPath = path.join(__dirname, subDir);
        const subDirFiles = fs.readdirSync(subDirPath)
          .filter(file => file.endsWith('.csv'))
          .map(file => ({ 
            name: file, 
            path: path.join(subDir, file), 
            location: `Directory: ${subDir}` 
          }));
        
        csvFiles.push(...subDirFiles);
      } catch (error) {
        // Ignora errori di accesso alle sottocartelle
      }
    }
    
    // Cerca nella cartella Desktop (percorso comune per molti utenti)
    const possiblePaths = [
      path.join(require('os').homedir(), 'Desktop'),
      path.join(require('os').homedir(), 'Documents'),
      path.join(require('os').homedir(), 'Downloads')
    ];
    
    for (const searchPath of possiblePaths) {
      try {
        if (fs.existsSync(searchPath)) {
          const desktopFiles = fs.readdirSync(searchPath)
            .filter(file => file.endsWith('.csv'))
            .slice(0, 10) // Limita a 10 file per cartella per evitare troppi risultati
            .map(file => ({ 
              name: file, 
              path: path.join(searchPath, file), 
              location: path.basename(searchPath) 
            }));
          
          csvFiles.push(...desktopFiles);
        }
      } catch (error) {
        // Ignora errori di accesso
      }
    }
    
    return csvFiles;
  } catch (error) {
    console.error('Errore nel cercare i file CSV:', error);
    return [];
  }
}

const isImageFile = filename => /\.(jpe?g|png|webp)$/i.test(filename);

function moveToUndefined(folder, item) {
  try {
    const sourcePath = CONFIG.GROUP_MODE ? 
      path.join(PATHS.base, folder, item) : 
      path.join(PATHS.base, folder, item);
    
    fse.ensureDirSync(PATHS.undefined);
    
    if (CONFIG.GROUP_MODE) {
      const targetPath = path.join(PATHS.undefined, item);
      fse.moveSync(sourcePath, targetPath, { overwrite: true });
    } else {
      const targetPath = path.join(PATHS.undefined, item);
      fse.moveSync(sourcePath, targetPath, { overwrite: true });
    }
    
    return true;
  } catch (error) {
    console.error(`Error during move:`, error);
    return false;
  }
}

function moveClusterToUndefined(folder) {
  try {
    const srcDir = path.join(PATHS.base, folder);
    const files = fs.readdirSync(srcDir);
    fse.ensureDirSync(PATHS.undefined);
    
    for (const file of files) {
      const src = path.join(srcDir, file);
      const dest = path.join(PATHS.undefined, file);
      if (fs.statSync(src).isFile()) {
        fse.moveSync(src, dest, { overwrite: true });
      }
    }
    fs.rmdirSync(srcDir);
    return true;
  } catch (error) {
    console.error('Errore nello spostamento cluster:', error);
    return false;
  }
}

// Generazione grids e contenuti
function generateHomeGrid() {
  const folders = getAllClusters();
  console.log(`🎯 Generating grid for ${folders.length} clusters`);
  
  let items = "";
  
  folders.forEach(folder => {
    console.log(`🔄 Processing cluster: ${folder}`);
    try {
      const clusterPath = path.join(PATHS.base, folder);
      console.log(`📁 Cluster path: ${clusterPath}`);
      
      let previewImage = null;
      
      if (CONFIG.GROUP_MODE) {
        console.log(`🔄 GROUP mode active`);
        const groups = fs.readdirSync(clusterPath, { withFileTypes: true })
          .filter(dirent => dirent.isDirectory())
          .map(dirent => dirent.name);
        
        console.log(`📂 Gruppi trovati in ${folder}:`, groups);
        
        for (const group of groups) {
          const groupPath = path.join(clusterPath, group);
          const images = fs.readdirSync(groupPath).filter(isImageFile);
          console.log(`🖼️ Images in group ${group}:`, images);
          if (images.length > 0) {
            previewImage = `/clusters/${folder}/${group}/${images[0]}`;
            console.log(`✅ Preview image for ${folder}: ${previewImage}`);
            break;
          }
        }
      } else {
        console.log(`🔄 SINGLE mode active`);
        const images = fs.readdirSync(clusterPath).filter(isImageFile);
        console.log(`🖼️ Images in ${folder}:`, images);
        if (images.length > 0) {
          previewImage = `/clusters/${folder}/${images[0]}`;
          console.log(`✅ Preview image for ${folder}: ${previewImage}`);
        }
      }
      
      if (previewImage) {
        items += `
          <a href="/cluster/${folder}" class="cluster-item">
            <img src="${previewImage}" alt="${folder}" />
            <div class="cluster-name">${folder}</div>
          </a>
        `;
        console.log(`✅ Added item for ${folder}`);
      } else {
        console.log(`⚠️ No preview image for ${folder}`);
      }
    } catch (error) {
      console.error(`❌ Error processing cluster ${folder}:`, error);
    }
  });
  
  console.log(`🎯 Grid generated with ${items.length > 0 ? 'content' : 'NO content'}`);
  return items;
}

function generateClusterContent(folder) {
  if (CONFIG.GROUP_MODE) {
    return generateGroupContentWithSelection(folder); // ← nuova funzione
  } else {
    return generateSingleContentWithSelection(folder); // ← nuova funzione
  }
}

function generateGroupContent(folder) {
  const clusterPath = path.join(PATHS.base, folder);
  let items = "";

  try {
    const groups = fs.readdirSync(clusterPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    for (const group of groups) {
      const groupPath = path.join(clusterPath, group);
      let images = [];
      
      try {
        images = fs.readdirSync(groupPath).filter(isImageFile);
      } catch (err) {
        console.error(`Error reading images for group ${group}:`, err);
        continue;
      }

      if (images.length === 0) continue;

      const stackHtml = images.map(img => {
        let sensorInfo = '';
        
        if (PATHS.csv && csvData.length > 0) {
          const imgName = path.parse(img).name;
          const csvTimestamp = convertFilenameToCSVTimestamp(imgName);
          const sensors = findClosestCSVRow(csvTimestamp);
          
          if (sensors) {
            sensorInfo = `
              <div class="sensor-popup">
                <h4>Sensor Data</h4>
                <p><strong>Timestamp:</strong> ${sensors.timestamp}</p>
                <p><strong>Lamp:</strong> ${sensors['light.lamp'] || 'N/A'}</p>
                <p><strong>Bed:</strong> ${sensors['light.bed'] || 'N/A'}</p>
                <p><strong>Desk:</strong> ${sensors['light.desk'] || 'N/A'}</p>
                <p><strong>Monitor:</strong> ${sensors['switch.monitor'] || 'N/A'}</p>
                <p><strong>Brightness:</strong> ${sensors['sensor.room_brightness'] || 'N/A'}</p>
              </div>
            `;
          } else {
            sensorInfo = '<div class="sensor-warning">Sensor data not available</div>';
          }
        }

        return `
          <div class="image-container">
            <img src="/clusters/${folder}/${group}/${img}" alt="${img}" class="stack-image" />
            ${sensorInfo ? `
              <button class="btn btn-info" onclick="this.nextElementSibling.classList.toggle('show')">
                ℹ️ Info
              </button>
              <div class="sensor-data">${sensorInfo}</div>
            ` : ''}
          </div>
        `;
      }).join('');

      items += `
        <div class="image-stack" data-group="${group}">
          <div class="group-header">
            <div style="display: flex; align-items: center; gap: 10px;">
              <input type="checkbox" class="group-checkbox" data-item="${group}" onchange="toggleSelection('${group}')">
              <h3>Group: ${group}</h3>
            </div>
            <button class="btn btn-undefined" onclick="moveToUndefined('${folder}', '${group}')">
              ⏳ Move to Undefined
            </button>
          </div>
          ${stackHtml}
        </div>
      `;
    }
  } catch (error) {
    console.error(`Error generating content for ${folder}:`, error);
  }

  return items;
}

function generateSingleContent(folder) {
  const clusterPath = path.join(PATHS.base, folder);
  let items = "";

  try {
    const images = fs.readdirSync(clusterPath).filter(isImageFile);
    
    items = images.map(img => {
      let sensorInfo = '';
      
      if (PATHS.csv && csvData.length > 0) {
        const imgName = path.parse(img).name;
        const csvTimestamp = convertFilenameToCSVTimestamp(imgName);
        const sensors = findClosestCSVRow(csvTimestamp);
        
        if (sensors) {
          sensorInfo = `
            <div class="sensor-popup">
              <h4>Sensor Data</h4>
              <p><strong>Timestamp:</strong> ${sensors.timestamp}</p>
              <p><strong>Lamp:</strong> ${sensors['light.lamp'] || 'N/A'}</p>
              <p><strong>Bed:</strong> ${sensors['light.bed'] || 'N/A'}</p>
              <p><strong>Desk:</strong> ${sensors['light.desk'] || 'N/A'}</p>
              <p><strong>Monitor:</strong> ${sensors['switch.monitor'] || 'N/A'}</p>
              <p><strong>Brightness:</strong> ${sensors['sensor.room_brightness'] || 'N/A'}</p>
            </div>
          `;
        } else {
          sensorInfo = '<div class="sensor-warning">Sensor data not available</div>';
        }
      }

      return `
        <div class="image-container" data-item="${img}">
          <input type="checkbox" class="item-checkbox" data-item="${img}" onchange="toggleSelection('${img}')">
          <img src="/clusters/${folder}/${img}" alt="${img}" class="single-image" />
          <button class="btn btn-undefined" onclick="moveToUndefined('${folder}', '${img}')">
            Move to Undefined
          </button>
          ${sensorInfo ? `
            <button class="btn btn-info" onclick="this.nextElementSibling.classList.toggle('show')">
              ℹ️ Info
            </button>
            <div class="sensor-data">${sensorInfo}</div>
          ` : ''}
        </div>
      `;
    }).join('');
  } catch (error) {
    console.error(`Error generating single content for ${folder}:`, error);
  }

  return items;
}

// ========================================
// ROUTES
// ========================================

// Route per le impostazioni
app.get("/settings", (req, res) => {
  const folders = getAllFolders();
  const csvFiles = getAllCSVFiles();
  
  const html = `
    <!DOCTYPE html>
    <html lang="it">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>⚙️ Impostazioni - Cluster Manager</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f5f5f5; padding: 20px; line-height: 1.6; }
        .container { max-width: 800px; margin: 0 auto; }
        .header { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); margin-bottom: 20px; }
        .back-link { color: #007bff; text-decoration: none; font-weight: 500; margin-bottom: 10px; display: inline-block; }
        .back-link:hover { text-decoration: underline; }
        h1 { color: #333; font-size: 2rem; }
        .settings-form { background: white; padding: 25px; border-radius: 12px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); }
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; margin-bottom: 8px; font-weight: 500; color: #333; }
        .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-family: inherit; font-size: 14px; }
        .form-group textarea { resize: vertical; min-height: 100px; }
        .checkbox-group { display: flex; align-items: center; gap: 8px; }
        .checkbox-group input[type="checkbox"] { width: auto; }
        .btn { padding: 12px 24px; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; font-size: 16px; transition: background-color 0.2s; }
        .btn-primary { background: #007bff; color: white; }
        .btn-primary:hover { background: #0056b3; }
        .btn-secondary { background: #6c757d; color: white; margin-left: 10px; }
        .btn-secondary:hover { background: #545b62; }
        .btn-danger { background: #dc3545; color: white; margin-left: 10px; }
        .btn-danger:hover { background: #c82333; }
        .current-config { background: #e3f2fd; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
        .current-config h3 { color: #1976d2; margin-bottom: 10px; }
        .current-config p { margin: 5px 0; font-size: 14px; color: #424242; }
        .alert { padding: 12px 16px; border-radius: 6px; margin: 10px 0; }
        .alert-success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
        .alert-error { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
        .help-text { font-size: 12px; color: #666; margin-top: 4px; }
        .actions-config { border: 1px solid #ddd; border-radius: 6px; padding: 15px; background: #f9f9f9; }
        .action-item { margin-bottom: 15px; padding: 10px; border: 1px solid #ccc; border-radius: 4px; background: white; }
        .action-item h4 { margin-bottom: 10px; color: #333; }
        .param-group { margin-bottom: 10px; }
        .param-group label { font-size: 12px; font-weight: normal; }
        .param-group input { margin-top: 4px; }
        .add-param-btn { background: #28a745; color: white; border: none; padding: 4px 8px; border-radius: 4px; font-size: 12px; cursor: pointer; }
        .remove-param-btn { background: #dc3545; color: white; border: none; padding: 4px 8px; border-radius: 4px; font-size: 12px; cursor: pointer; margin-left: 5px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <a href="/" class="back-link">← Torna alla Home</a>
          <h1>⚙️ Impostazioni</h1>
        </div>
        
        <div class="current-config">
          <h3>📋 Configurazione Attuale</h3>
          <p><strong>Cartella:</strong> ${CONFIG.BASE_FOLDER}</p>
          <p><strong>Modalità:</strong> ${CONFIG.GROUP_MODE ? 'Gruppi' : 'Singola'}</p>
          <p><strong>CSV:</strong> ${CONFIG.CSV_FILE || 'Disabilitato'}</p>
          <p><strong>Annotazioni:</strong> ${CONFIG.ANNOTATIONS_ENABLED ? 'Abilitate' : 'Disabilitate'}</p>
        </div>
        
        <div id="alert-container"></div>
        
        <form class="settings-form" onsubmit="saveSettings(event)">
          <div class="form-group">
            <label for="base-folder">📁 Cartella Base dei Cluster</label>
            <select id="base-folder" required>
              <option value="">Seleziona una cartella...</option>
              ${folders.map(folder => 
                `<option value="${folder}" ${folder === CONFIG.BASE_FOLDER ? 'selected' : ''}>${folder}</option>`
              ).join('')}
            </select>
            <div class="help-text">Seleziona la cartella che contiene i cluster</div>
          </div>
          
          <div class="form-group">
            <label for="csv-file">📊 File CSV dei Sensori</label>
            <select id="csv-file">
              <option value="">Nessuno (disabilita sensori)</option>
              ${csvFiles.map(file => 
                `<option value="${file.path}" ${file.path === CONFIG.CSV_FILE ? 'selected' : ''}>${file.name} (${file.location})</option>`
              ).join('')}
            </select>
            <div class="help-text">File CSV contenente i dati dei sensori (opzionale)</div>
            <div class="help-text" style="margin-top: 8px;">
              <strong>📁 Percorso personalizzato:</strong> 
              <input type="text" id="csv-custom-path" placeholder="Inserisci percorso completo del file CSV..." style="width: 100%; margin-top: 5px;">
              <button type="button" class="btn btn-secondary" onclick="useCustomCSVPath()" style="margin-top: 5px;">Usa Percorso Personalizzato</button>
            </div>
          </div>
          
          <div class="form-group">
            <div class="checkbox-group">
              <input type="checkbox" id="group-mode" ${CONFIG.GROUP_MODE ? 'checked' : ''}>
              <label for="group-mode">🔄 Modalità Gruppi</label>
            </div>
            <div class="help-text">Se abilitata, ogni cluster è organizzato in sottocartelle (gruppi di immagini)</div>
          </div>
          
          <div class="form-group">
            <div class="checkbox-group">
              <input type="checkbox" id="annotations-enabled" ${CONFIG.ANNOTATIONS_ENABLED ? 'checked' : ''}>
              <label for="annotations-enabled">📝 Abilita Annotazioni</label>
            </div>
            <div class="help-text">Se abilitata, permette di creare annotazioni avanzate con azioni e descrizioni</div>
          </div>
          
          <div class="form-group" id="actions-config-group">
            <label>⚡ Configurazione Azioni (solo se annotazioni abilitate)</label>
            <div class="actions-config">
              <div id="actions-container">
                ${Object.entries(CONFIG.actionParams).map(([actionName, params]) => `
                  <div class="action-item" data-action="${actionName}">
                    <h4>${actionName}</h4>
                    <div class="params-container">
                      ${params.map((paramOptions, index) => `
                        <div class="param-group">
                          <label>Parametro ${index + 1}:</label>
                          <input type="text" value="${paramOptions.join(', ')}" placeholder="Opzioni separate da virgola">
                          <button type="button" class="remove-param-btn" onclick="removeParam(this)">Rimuovi</button>
                        </div>
                      `).join('')}
                    </div>
                    <button type="button" class="add-param-btn" onclick="addParam(this)">+ Aggiungi Parametro</button>
                    <button type="button" class="remove-param-btn" onclick="removeAction(this)" style="margin-left: 10px;">Rimuovi Azione</button>
                  </div>
                `).join('')}
              </div>
              <button type="button" class="btn btn-secondary" onclick="addAction()">+ Aggiungi Azione</button>
            </div>
            <div class="help-text">Configura le azioni disponibili per le annotazioni</div>
          </div>
          
          <div style="margin-top: 30px;">
            <button type="submit" class="btn btn-primary">💾 Salva Impostazioni</button>
            <button type="button" class="btn btn-secondary" onclick="resetToDefault()">🔄 Ripristina Default</button>
            <button type="button" class="btn btn-danger" onclick="restartServer()">🔄 Riavvia Server</button>
          </div>
        </form>
      </div>
      
      <script>
        function showAlert(message, type = 'success') {
          const container = document.getElementById('alert-container');
          const alertClass = type === 'success' ? 'alert-success' : 'alert-error';
          container.innerHTML = '<div class="alert ' + alertClass + '">' + message + '</div>';
          setTimeout(() => container.innerHTML = '', 5000);
        }
        
        function addParam(button) {
          const paramsContainer = button.previousElementSibling;
          const paramCount = paramsContainer.children.length + 1;
          const paramDiv = document.createElement('div');
          paramDiv.className = 'param-group';
          paramDiv.innerHTML = \`
            <label>Parametro \${paramCount}:</label>
            <input type="text" placeholder="Opzioni separate da virgola">
            <button type="button" class="remove-param-btn" onclick="removeParam(this)">Rimuovi</button>
          \`;
          paramsContainer.appendChild(paramDiv);
        }
        
        function removeParam(button) {
          button.parentElement.remove();
        }
        
        function addAction() {
          const container = document.getElementById('actions-container');
          const actionName = prompt('Nome della nuova azione:');
          if (!actionName) return;
          
          const actionDiv = document.createElement('div');
          actionDiv.className = 'action-item';
          actionDiv.setAttribute('data-action', actionName);
          actionDiv.innerHTML = \`
            <h4>\${actionName}</h4>
            <div class="params-container"></div>
            <button type="button" class="add-param-btn" onclick="addParam(this)">+ Aggiungi Parametro</button>
            <button type="button" class="remove-param-btn" onclick="removeAction(this)" style="margin-left: 10px;">Rimuovi Azione</button>
          \`;
          container.appendChild(actionDiv);
        }
        
        function removeAction(button) {
          button.closest('.action-item').remove();
        }
        
        function useCustomCSVPath() {
          const customPath = document.getElementById('csv-custom-path').value.trim();
          if (!customPath) {
            alert('Inserisci un percorso valido');
            return;
          }
          
          // Estrai il nome del file dal percorso
          const fileName = customPath.split('/').pop().split('\\\\').pop();
          
          // Aggiungi l'opzione personalizzata al select
          const select = document.getElementById('csv-file');
          const existingOption = Array.from(select.options).find(opt => opt.value === customPath);
          
          if (!existingOption) {
            const newOption = document.createElement('option');
            newOption.value = customPath;
            newOption.text = fileName + ' (Percorso personalizzato)';
            newOption.selected = true;
            select.appendChild(newOption);
          } else {
            existingOption.selected = true;
          }
          
          document.getElementById('csv-custom-path').value = '';
        }
        
        async function saveSettings(event) {
          event.preventDefault();
          
          try {
            const baseFolder = document.getElementById('base-folder').value;
            const csvFile = document.getElementById('csv-file').value || null;
            const groupMode = document.getElementById('group-mode').checked;
            const annotationsEnabled = document.getElementById('annotations-enabled').checked;
            
            // Raccogli le azioni
            const actionParams = {};
            document.querySelectorAll('.action-item').forEach(actionDiv => {
              const actionName = actionDiv.getAttribute('data-action');
              const params = [];
              actionDiv.querySelectorAll('.param-group input').forEach(input => {
                if (input.value.trim()) {
                  params.push(input.value.split(',').map(s => s.trim()).filter(s => s));
                }
              });
              if (params.length > 0) {
                actionParams[actionName] = params;
              }
            });
            
            const newConfig = {
              BASE_FOLDER: baseFolder,
              CSV_FILE: csvFile,
              GROUP_MODE: groupMode,
              ANNOTATIONS_ENABLED: annotationsEnabled,
              actionParams: annotationsEnabled ? actionParams : {}
            };
            
            const response = await fetch('/save-settings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(newConfig)
            });
            
            if (response.ok) {
              showAlert('✅ Impostazioni salvate! Il server verrà riavviato...');
              setTimeout(() => {
                window.location.href = '/restart';
              }, 2000);
            } else {
              throw new Error('Errore del server');
            }
          } catch (err) {
            showAlert('❌ Errore: ' + err.message, 'error');
          }
        }
        
        async function resetToDefault() {
          if (!confirm('Ripristinare tutte le impostazioni ai valori di default?')) return;
          
          try {
            const response = await fetch('/reset-settings', {
              method: 'POST'
            });
            
            if (response.ok) {
              showAlert('✅ Impostazioni ripristinate!');
              setTimeout(() => location.reload(), 1500);
            } else {
              throw new Error('Errore del server');
            }
          } catch (err) {
            showAlert('❌ Errore: ' + err.message, 'error');
          }
        }
        
        async function restartServer() {
          if (!confirm('Riavviare il server? Tutte le connessioni verranno interrotte.')) return;
          
          try {
            await fetch('/restart', { method: 'POST' });
            showAlert('🔄 Server in riavvio...');
            setTimeout(() => window.location.href = '/', 3000);
          } catch (err) {
            // Il server si sta riavviando, quindi l'errore è normale
            showAlert('🔄 Server in riavvio...');
            setTimeout(() => window.location.href = '/', 3000);
          }
        }
        
        // Mostra/nascondi configurazione azioni in base al checkbox annotazioni
        document.getElementById('annotations-enabled').addEventListener('change', function() {
          const actionsGroup = document.getElementById('actions-config-group');
          actionsGroup.style.display = this.checked ? 'block' : 'none';
        });
        
        // Inizializza visibilità
        document.getElementById('actions-config-group').style.display = 
          document.getElementById('annotations-enabled').checked ? 'block' : 'none';
      </script>
    </body>
    </html>
  `;
  
  res.send(html);
});

app.get("/", (req, res) => {
  const gridContent = generateHomeGrid();
  
  const html = `
    <!DOCTYPE html>
    <html lang="it">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Cluster Manager</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f5f5f5; padding: 20px; line-height: 1.6; }
        .config-info { background: #e3f2fd; padding: 15px; border-radius: 8px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; }
        .config-details h3 { color: #1976d2; margin-bottom: 10px; }
        .config-details p { margin: 5px 0; font-size: 14px; color: #424242; }
        .settings-btn { background: #007bff; color: white; padding: 10px 20px; border: none; border-radius: 6px; text-decoration: none; font-weight: 500; transition: background 0.2s; }
        .settings-btn:hover { background: #0056b3; }
        h1 { color: #333; margin-bottom: 30px; text-align: center; font-size: 2.5rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 20px; max-width: 1200px; margin: 0 auto; }
        .cluster-item { background: white; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); text-decoration: none; color: #333; text-align: center; transition: transform 0.2s, box-shadow 0.2s; overflow: hidden; }
        .cluster-item:hover { transform: translateY(-4px); box-shadow: 0 8px 20px rgba(0, 0, 0, 0.15); }
        .cluster-item img { width: 100%; height: 140px; object-fit: cover; }
        .cluster-name { padding: 15px; font-weight: 600; font-size: 0.9rem; }
        .nav-buttons { text-align: center; margin-bottom: 20px; }
        .nav-buttons a { display: inline-block; padding: 10px 20px; margin: 0 10px; background: #007bff; color: white; text-decoration: none; border-radius: 6px; transition: background 0.2s; }
        .nav-buttons a:hover { background: #0056b3; }
        .status-indicator { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
        .status-active { background: #28a745; }
        .status-inactive { background: #dc3545; }
        .no-clusters { text-align: center; padding: 40px; background: white; border-radius: 12px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); }
      </style>
    </head>
    <body>
      <div class="config-info">
        <div class="config-details">
          <h3>⚙️ Configurazione Attuale</h3>
          <p><strong>Cartella:</strong> ${CONFIG.BASE_FOLDER} ${fs.existsSync(PATHS.base) ? '<span class="status-indicator status-active"></span>' : '<span class="status-indicator status-inactive"></span>'}</p>
          <p><strong>Modalità:</strong> ${CONFIG.GROUP_MODE ? 'Gruppi' : 'Singola'}</p>
          <p><strong>CSV:</strong> ${CONFIG.CSV_FILE ? CONFIG.CSV_FILE + (csvData.length > 0 ? ` (${csvData.length} righe)` : ' (vuoto)') : 'Disabilitato'} ${CONFIG.CSV_FILE && fs.existsSync(PATHS.csv) ? '<span class="status-indicator status-active"></span>' : '<span class="status-indicator status-inactive"></span>'}</p>
          <p><strong>Annotazioni:</strong> ${CONFIG.ANNOTATIONS_ENABLED ? 'Abilitate' : 'Disabilitate'}</p>
        </div>
        <a href="/settings" class="settings-btn">⚙️ Modifica Impostazioni</a>
      </div>
      
      <h1>🖼️ Cluster Manager</h1>
      
      <div class="nav-buttons">
        <a href="/review">📝 Review Mode</a>
        <a href="/merge">🔀 Unisci Cluster</a>
        ${CONFIG.ANNOTATIONS_ENABLED ? '<a href="/annotations">📋 Gestisci Annotazioni</a>' : ''}
        <a href="/settings">⚙️ Impostazioni</a>
      </div>
      
      ${!fs.existsSync(PATHS.base) ? `
        <div class="no-clusters">
          <h2>⚠️ Cartella non trovata</h2>
          <p>La cartella "${CONFIG.BASE_FOLDER}" non esiste.</p>
          <p><a href="/settings">Configura le impostazioni</a> per selezionare una cartella valida.</p>
        </div>
      ` : getAllClusters().length === 0 ? `
        <div class="no-clusters">
          <h2>📂 Nessun cluster trovato</h2>
          <p>La cartella "${CONFIG.BASE_FOLDER}" non contiene cluster (cartelle che iniziano con "cluster_").</p>
        </div>
      ` : `
        <div class="grid">
          ${gridContent}
        </div>
      `}
    </body>
    </html>
  `;
  
  res.send(html);
});

// Route per salvare le impostazioni
app.post('/save-settings', (req, res) => {
  try {
    const newConfig = req.body;
    
    // Validazione base
    if (!newConfig.BASE_FOLDER) {
      return res.status(400).json({ error: 'Cartella base richiesta' });
    }
    
    // Save configuration
    CONFIG = { ...DEFAULT_CONFIG, ...newConfig };
    const saved = saveConfig(CONFIG);
    
    if (saved) {
      // Aggiorna paths e ricarica CSV
      updatePaths();
      
      res.json({ success: true, message: 'Impostazioni salvate' });
    } else {
      res.status(500).json({ error: 'Errore nel salvare le impostazioni' });
    }
  } catch (error) {
    console.error('Errore nel salvare impostazioni:', error);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// Route per ripristinare impostazioni default
app.post('/reset-settings', (req, res) => {
  try {
    CONFIG = { ...DEFAULT_CONFIG };
    const saved = saveConfig(CONFIG);
    
    if (saved) {
      updatePaths();
      res.json({ success: true, message: 'Impostazioni ripristinate' });
    } else {
      res.status(500).json({ error: 'Errore nel ripristinare le impostazioni' });
    }
  } catch (error) {
    console.error('Errore nel ripristinare impostazioni:', error);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// Route per riavviare il server
app.post('/restart', (req, res) => {
  res.json({ success: true, message: 'Server in riavvio...' });
  
  setTimeout(() => {
    console.log('🔄 Riavvio del server richiesto...');
    
    // Ricarica configurazione e dati
    CONFIG = loadConfig();
    updatePaths();
    
    // Ricarica dati CSV
    loadCSVData().then(() => {
      console.log('✅ Configurazione e dati ricaricati');
    }).catch(err => {
      console.error('Errore nel ricaricare i dati CSV:', err);
    });
    
  }, 1000);
});

app.get('/restart', (req, res) => {
  res.send(`
    <html>
      <head>
        <meta http-equiv="refresh" content="3;url=/">
        <title>Riavvio in corso...</title>
        <style>
          body { font-family: sans-serif; text-align: center; padding: 40px; background: #f5f5f5; }
          .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #007bff; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        </style>
      </head>
      <body>
        <h1>🔄 Riavvio in corso...</h1>
        <div class="spinner"></div>
        <p>Verrai reindirizzato automaticamente alla home page.</p>
        <p>Se non vieni reindirizzato, <a href="/">clicca qui</a>.</p>
      </body>
    </html>
  `);
});

// aggiungere qua

app.get("/cluster/:name", (req, res) => {
  const folder = req.params.name;
  const clusterPath = path.join(PATHS.base, folder);
  
  if (!fs.existsSync(clusterPath)) {
    return res.status(404).send(`
      <html>
        <body style="font-family: sans-serif; padding: 40px; text-align: center;">
          <h1>❌ Cluster non trovato</h1>
          <p>Il cluster "${folder}" non esiste.</p>
          <a href="/" style="color: #007bff;">← Torna alla home</a>
        </body>
      </html>
    `);
  }
  
  const content = generateClusterContent(folder);
  
  const html = `
    <!DOCTYPE html>
    <html lang="it">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${folder} - Cluster View</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f8f9fa; padding: 20px; line-height: 1.6; }
        .header { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); margin-bottom: 20px; }
        .back-link { color: #007bff; text-decoration: none; font-weight: 500; }
        .back-link:hover { text-decoration: underline; }
        h1 { color: #333; margin: 10px 0; font-size: 2rem; }
        .btn { padding: 10px 16px; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; margin: 4px; transition: background-color 0.2s; }
        .btn-primary { background: #007bff; color: white; }
        .btn-primary:hover { background: #0056b3; }
        .btn-danger { background: #dc3545; color: white; }
        .btn-danger:hover { background: #c82333; }
        .btn-success { background: #28a745; color: white; }
        .btn-success:hover { background: #218838; }
        .btn-info { background: #17a2b8; color: white; }
        .btn-info:hover { background: #138496; }
        .btn-undefined { background: #ffc107; color: #212529; }
        .btn-undefined:hover { background: #e0a800; }
        .btn-secondary { background: #6c757d; color: white; }
        .btn-secondary:hover { background: #545b62; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 20px; }
        .image-stack, .image-container { background: white; border-radius: 12px; padding: 15px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); }
        .group-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #eee; }
        .stack-image, .single-image { max-width: 100%; height: auto; border-radius: 8px; margin: 8px 0; display: block; }
        .single-image { max-width: 200px; }
        .sensor-data { display: none; background: #f8f9fa; border-radius: 8px; padding: 10px; margin-top: 10px; border: 1px solid #dee2e6; font-size: 0.85rem; }
        .sensor-data.show { display: block; }
        .sensor-popup { text-align: left; }
        .sensor-popup p { margin: 5px 0; }
        .sensor-warning { color: #dc3545; font-style: italic; }
        .text-center { text-align: center; }

        /* Selection bar styles */
        .selection-bar {
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          background: #212529;
          color: white;
          padding: 15px 20px;
          display: none;
          align-items: center;
          justify-content: space-between;
          box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.2);
          z-index: 1000;
        }
        .selection-bar.show { display: flex; }
        .selection-info { font-size: 16px; }
        .selection-actions { display: flex; gap: 10px; }
        .item-checkbox, .group-checkbox {
          position: absolute;
          top: 10px;
          left: 10px;
          width: 20px;
          height: 20px;
          cursor: pointer;
          z-index: 10;
        }
        .image-container, .image-stack {
          position: relative;
        }
        .image-container.selected, .image-stack.selected {
          outline: 3px solid #007bff;
          background: #e3f2fd;
        }

        /* Modal styles */
        .modal {
          display: none;
          position: fixed;
          z-index: 2000;
          left: 0;
          top: 0;
          width: 100%;
          height: 100%;
          background-color: rgba(0,0,0,0.5);
        }
        .modal.show { display: flex; align-items: center; justify-content: center; }
        .modal-content {
          background: white;
          padding: 20px;
          border-radius: 12px;
          max-width: 700px;
          max-height: 80vh;
          overflow-y: auto;
          width: 90%;
        }
        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }
        .modal-close {
          font-size: 28px;
          cursor: pointer;
          color: #666;
        }
        .modal-close:hover { color: #000; }
        .cluster-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
          gap: 15px;
        }
        .cluster-option {
          cursor: pointer;
          text-align: center;
          padding: 10px;
          border: 2px solid #ddd;
          border-radius: 8px;
          transition: all 0.2s;
        }
        .cluster-option:hover {
          border-color: #007bff;
          background: #f0f8ff;
        }
        .cluster-option.new-cluster {
          border: 2px dashed #28a745;
          background: #f0fff0;
        }
        .cluster-option.new-cluster:hover {
          border-color: #28a745;
          background: #e8f5e8;
        }
        .cluster-option img {
          width: 100%;
          height: 100px;
          object-fit: cover;
          border-radius: 4px;
          margin-bottom: 8px;
        }
        .cluster-option-name {
          font-size: 14px;
          font-weight: 500;
        }

        /* New cluster input */
        .new-cluster-input {
          display: none;
          margin-top: 15px;
          padding: 15px;
          background: #f8f9fa;
          border-radius: 8px;
          border: 1px solid #dee2e6;
        }
        .new-cluster-input.show { display: block; }
        .new-cluster-input input {
          width: 100%;
          padding: 10px;
          border: 1px solid #ced4da;
          border-radius: 6px;
          margin-bottom: 10px;
          font-family: inherit;
        }
        .new-cluster-input .btn-group {
          display: flex;
          gap: 10px;
        }
        
        ${CONFIG.ANNOTATIONS_ENABLED ? `
        .form-area { background: white; padding: 25px; border-radius: 12px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); margin-bottom: 30px; }
        .form-section { margin-bottom: 20px; }
        .form-section h3 { color: #495057; margin-bottom: 15px; font-size: 1.1rem; }
        .action-item { background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; padding: 15px; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
        .text-field { background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; padding: 15px; margin-bottom: 15px; }
        .text-field label { display: block; margin-bottom: 8px; font-weight: 500; color: #495057; }
        .text-field input, .text-field textarea { width: 100%; padding: 10px; border: 1px solid #ced4da; border-radius: 6px; font-family: inherit; font-size: 14px; }
        .text-field textarea { resize: vertical; min-height: 80px; }
        select { padding: 8px; border: 1px solid #ced4da; border-radius: 4px; margin: 4px; font-family: inherit; }
        .alert { padding: 12px 16px; border-radius: 6px; margin: 10px 0; }
        .alert-success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
        .alert-error { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
        ` : ''}
      </style>
    </head>
    <body>
      <div class="header">
        <a href="/" class="back-link">← Indietro</a>
        <h1>📝 ${folder}</h1>
        <button class="btn btn-danger" onclick="moveWholeCluster()">🗑️ Sposta Cluster in Undefined</button>
      </div>
      
      ${CONFIG.ANNOTATIONS_ENABLED ? `
      <div class="form-area">
        <div class="form-section">
          <h3>📝 Descrizioni Avanzate</h3>
          <div class="text-field">
            <label for="simple-description">🔍 Descrizione semplice:</label>
            <input type="text" id="simple-description" placeholder="Inserisci una descrizione breve del cluster...">
          </div>
          <div class="text-field">
            <label for="output-vocale">🎤 Output vocale:</label>
            <textarea id="output-vocale" placeholder="Inserisci il testo da convertire in audio..."></textarea>
          </div>
        </div>

        <div class="form-section">
          <h3>⚡ Azioni</h3>
          <div id="actions-container"></div>
          <button type="button" class="btn btn-primary" onclick="addAction()">
            + Aggiungi Azione
          </button>
        </div>
        
        <button class="btn btn-success" onclick="saveAnnotations()">
          💾 Salva Annotazioni
        </button>
        
        <div id="alert-container"></div>
      </div>
      ` : ''}
      
      <div class="grid">
        ${content}
      </div>

      <!-- Selection bar -->
      <div class="selection-bar" id="selection-bar">
        <div class="selection-info">
          <span id="selection-count">0</span> elementi selezionati
        </div>
        <div class="selection-actions">
          <button class="btn btn-primary" onclick="selectAll()">Seleziona Tutto</button>
          <button class="btn btn-secondary" onclick="deselectAll()">Deseleziona</button>
          <button class="btn btn-undefined" onclick="moveSelectedToUndefined()">Move to Undefined</button>
          <button class="btn btn-success" onclick="showClusterSelectionModal()">Sposta in Cluster</button>
        </div>
      </div>

      <!-- Cluster selection modal -->
      <div id="cluster-modal" class="modal">
        <div class="modal-content">
          <div class="modal-header">
            <h2>Seleziona cluster di destinazione</h2>
            <span class="modal-close" onclick="closeModal()">&times;</span>
          </div>
          <div id="cluster-grid" class="cluster-grid">
            <!-- Populated dynamically -->
          </div>
          <div class="new-cluster-input" id="new-cluster-input">
            <h4>🆕 Crea nuovo cluster</h4>
            <input type="text" id="new-cluster-name" placeholder="Nome del nuovo cluster (es: cluster_123 o descrizione)" maxlength="50">
            <div class="btn-group">
              <button class="btn btn-success" onclick="createAndMoveToNewCluster()">✅ Crea e Sposta</button>
              <button class="btn btn-secondary" onclick="cancelNewCluster()">❌ Annulla</button>
            </div>
          </div>
        </div>
      </div>
      
      <script>
        ${CONFIG.ANNOTATIONS_ENABLED ? `
        const ACTIONS = ${JSON.stringify(ACTIONS)};
        const CONFIG_ACTIONS = ${JSON.stringify(CONFIG.actionParams)};
        
        function showAlert(message, type = 'success') {
          const container = document.getElementById('alert-container');
          const alertClass = type === 'success' ? 'alert-success' : 'alert-error';
          container.innerHTML = '<div class="alert ' + alertClass + '">' + message + '</div>';
          setTimeout(() => container.innerHTML = '', 5000);
        }
        
        function addAction() {
          const container = document.getElementById('actions-container');
          const idx = container.children.length;
          
          const actionDiv = document.createElement('div');
          actionDiv.className = 'action-item';
          actionDiv.setAttribute('data-idx', idx);

          const actionSelect = document.createElement('select');
          actionSelect.id = "action_" + idx;
          actionSelect.style.flex = '1';
          ACTIONS.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a;
            opt.text = a;
            actionSelect.append(opt);
          });

          const paramsContainer = document.createElement('div');
          paramsContainer.id = "params_" + idx;
          paramsContainer.style.display = 'flex';
          paramsContainer.style.gap = '8px';

          function renderParams() {
            paramsContainer.innerHTML = '';
            const selected = actionSelect.value;
            if (CONFIG_ACTIONS[selected]) {
              CONFIG_ACTIONS[selected].forEach((options, pi) => {
                const sel = document.createElement('select');
                sel.size = 1;
                options.forEach(optVal => {
                  const o = document.createElement('option');
                  o.value = optVal;
                  o.text = optVal;
                  sel.append(o);
                });
                paramsContainer.append(sel);
              });
            }
          }

          actionSelect.addEventListener('change', renderParams);
          renderParams();

          const removeBtn = document.createElement('button');
          removeBtn.className = 'btn btn-danger';
          removeBtn.textContent = '🗑️';
          removeBtn.onclick = () => actionDiv.remove();

          actionDiv.append(actionSelect, paramsContainer, removeBtn);
          container.appendChild(actionDiv);
        }

        async function saveAnnotations() {
          try {
            const actions = [];
            document.querySelectorAll(".action-item").forEach(div => {
              const idx = div.getAttribute('data-idx');
              const actionName = div.querySelector("#action_" + idx).value;
              const params = Array.from(div.querySelectorAll('#params_' + idx + ' select'))
                .map(sel => sel.value);
              actions.push({ action_name: actionName, params });
            });

            const simpleDescription = document.getElementById('simple-description').value;
            const outputVocale = document.getElementById('output-vocale').value;

            const response = await fetch('/annotate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                folder: '${folder}', 
                actions,
                simple_description: simpleDescription,
                output_vocale: outputVocale
              })
            });

            if (response.ok) {
              showAlert('✅ Annotazioni salvate con successo!');
              setTimeout(() => window.location.href = '/review', 800);
            } else throw new Error('Server error');
          } catch (err) {
            showAlert('❌ Errore: ' + err.message, 'error');
          }
        }

        document.addEventListener('DOMContentLoaded', () => addAction());
        ` : ''}
        
        // Selection management
        let selectedItems = new Set();

        function toggleSelection(item) {
          const element = document.querySelector(\`[data-item="\${item}"]\`);
          const checkbox = element.querySelector('input[type="checkbox"]');
          
          if (selectedItems.has(item)) {
            selectedItems.delete(item);
            element.classList.remove('selected');
            if (checkbox) checkbox.checked = false;
          } else {
            selectedItems.add(item);
            element.classList.add('selected');
            if (checkbox) checkbox.checked = true;
          }
          
          updateSelectionBar();
        }

        function updateSelectionBar() {
          const bar = document.getElementById('selection-bar');
          const count = document.getElementById('selection-count');
          
          if (selectedItems.size > 0) {
            bar.classList.add('show');
            count.textContent = selectedItems.size;
          } else {
            bar.classList.remove('show');
          }
        }

        function selectAll() {
          const checkboxes = document.querySelectorAll('.item-checkbox, .group-checkbox');
          checkboxes.forEach(cb => {
            const item = cb.getAttribute('data-item');
            if (!selectedItems.has(item)) {
              cb.checked = true;
              selectedItems.add(item);
              cb.closest('[data-item]').classList.add('selected');
            }
          });
          updateSelectionBar();
        }

        function deselectAll() {
          selectedItems.clear();
          document.querySelectorAll('.item-checkbox, .group-checkbox').forEach(cb => {
            cb.checked = false;
            cb.closest('[data-item]').classList.remove('selected');
          });
          updateSelectionBar();
        }

        async function moveSelectedToUndefined() {
          if (selectedItems.size === 0) {
            alert('Nessun elemento selezionato');
            return;
          }
          
          if (!confirm(\`Spostare \${selectedItems.size} elementi in undefined?\`)) return;
          
          try {
            const response = await fetch('/move-multiple-to-undefined', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                folder: '${folder}',
                items: Array.from(selectedItems)
              })
            });
            
            const result = await response.json();
            
            if (result.success) {
              alert(\`Spostati \${result.moved} elementi su \${result.total}\`);
              location.reload();
            } else {
              alert('Errore: ' + (result.error || 'Sconosciuto'));
            }
          } catch (err) {
            alert('Errore: ' + err.message);
          }
        }

        async function showClusterSelectionModal() {
          if (selectedItems.size === 0) {
            alert('Nessun elemento selezionato');
            return;
          }
          
          try {
            const response = await fetch('/api/cluster-previews-extended');
            const clusters = await response.json();
            
            const grid = document.getElementById('cluster-grid');
            grid.innerHTML = clusters
              .filter(c => c.name !== '${folder}' && c.name !== '_CREATE_NEW_') // Escludi il cluster corrente
              .map(cluster => \`
                <div class="cluster-option" onclick="moveSelectedToCluster('\${cluster.name}')">
                  <img src="\${cluster.preview}" alt="\${cluster.displayName}" />
                  <div class="cluster-option-name">\${cluster.displayName}</div>
                </div>
              \`).join('') + \`
              <div class="cluster-option new-cluster" onclick="showNewClusterInput()">
                <div style="height: 100px; display: flex; align-items: center; justify-content: center; font-size: 48px; color: #28a745;">+</div>
                <div class="cluster-option-name">🆕 Crea Nuovo Cluster</div>
              </div>
            \`;
            
            document.getElementById('cluster-modal').classList.add('show');
          } catch (err) {
            alert('Errore nel caricamento cluster: ' + err.message);
          }
        }

        function showNewClusterInput() {
          document.getElementById('new-cluster-input').classList.add('show');
          document.getElementById('new-cluster-name').focus();
        }

        function cancelNewCluster() {
          document.getElementById('new-cluster-input').classList.remove('show');
          document.getElementById('new-cluster-name').value = '';
        }

        async function createAndMoveToNewCluster() {
          const newClusterName = document.getElementById('new-cluster-name').value.trim();
          
          if (!newClusterName) {
            alert('Inserisci un nome per il nuovo cluster');
            return;
          }
          
          if (!confirm(\`Creare il nuovo cluster "\${newClusterName}" e spostare \${selectedItems.size} elementi?\`)) return;
          
          try {
            const response = await fetch('/move-to-new-cluster', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sourceFolder: '${folder}',
                newClusterName: newClusterName,
                items: Array.from(selectedItems)
              })
            });
            
            const result = await response.json();
            
            if (result.success) {
              alert(\`✅ Nuovo cluster "\${result.targetCluster}" creato!\\nSpostati \${result.moved} elementi su \${result.total}\`);
              location.reload();
            } else {
              alert('Errore: ' + (result.error || 'Sconosciuto'));
            }
          } catch (err) {
            alert('Errore: ' + err.message);
          }
        }

        function closeModal() {
          document.getElementById('cluster-modal').classList.remove('show');
          cancelNewCluster();
        }

        async function moveSelectedToCluster(targetCluster) {
          if (!confirm(\`Spostare \${selectedItems.size} elementi in \${targetCluster}?\`)) return;
          
          try {
            const response = await fetch('/move-to-cluster', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sourceFolder: '${folder}',
                targetFolder: targetCluster,
                items: Array.from(selectedItems)
              })
            });
            
            const result = await response.json();
            
            if (result.success) {
              alert(\`Spostati \${result.moved} elementi su \${result.total}\`);
              location.reload();
            } else {
              alert('Errore: ' + (result.error || 'Sconosciuto'));
            }
          } catch (err) {
            alert('Errore: ' + err.message);
          }
        }

        // Other functions
        async function moveToUndefined(folder, item) {
          const itemType = ${CONFIG.GROUP_MODE} ? 'gruppo' : 'immagine';
          if (!confirm(\`Spostare \${itemType} \${item} in undefined?\`)) return;
          
          try {
            const response = await fetch('/move-to-undefined', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ folder, item })
            });
            
            if (response.ok) {
              alert(\`\${itemType} spostata!\`);
              location.reload();
            } else {
              throw new Error('Errore del server');
            }
          } catch (err) {
            alert('❌ Errore: ' + err.message);
          }
        }
        
        async function moveWholeCluster() {
          if (!confirm('Spostare tutto il cluster in undefined?')) return;
          
          try {
            const response = await fetch('/move-cluster', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ folder: '${folder}' })
            });
            
            if (response.ok) {
              alert('Cluster spostato!');
              window.location.href = '/';
            } else {
              throw new Error('Errore del server');
            }
          } catch (err) {
            alert('❌ Errore: ' + err.message);
          }
        }

        // Close modal when clicking outside
        window.onclick = function(event) {
          const modal = document.getElementById('cluster-modal');
          if (event.target == modal) {
            closeModal();
          }
        }
      </script>
    </body>
    </html>
  `;
  
  res.send(html);
});

// ========================================
// ROUTE REVIEW AGGIORNATA
// ========================================

app.get('/review', (req, res) => {
  const described = getDescribedFolders();
  const processed = getProcessedFolders();
  const allClusters = getAllClusters().sort((a, b) => {
    const na = parseInt(a.split('_')[1]);
    const nb = parseInt(b.split('_')[1]);
    return na - nb;
  });
  
  const remainingClusters = allClusters.filter(f => !processed.has(f));
  
  if (remainingClusters.length === 0) {
    return res.send(`
      <html>
        <body style="font-family: sans-serif; padding: 40px; text-align: center;">
          <h1>🎉 Tutti i cluster sono stati processati!</h1>
          <p>Non ci sono più cluster da annotare.</p>
          <a href="/" style="color: #007bff;">← Torna alla home</a>
        </body>
      </html>
    `);
  }

  const folder = remainingClusters[0];
  const content = generateClusterContent(folder);

  const total = allClusters.length;
  const done = processed.size;
  const remaining = total - done;

  const html = `
    <!DOCTYPE html>
    <html lang="it">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Review ${folder}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #fafafa; padding: 20px; line-height: 1.6; }
        .header { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); margin-bottom: 20px; }
        h1 { color: #333; margin-bottom: 10px; font-size: 2rem; }
        .counter { margin-bottom: 20px; font-weight: bold; color: #333; font-size: 1.1rem; }
        .controls { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); margin-bottom: 20px; }
        .btn { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; margin: 4px; transition: background-color 0.2s; }
        .btn-primary { background: #007bff; color: white; }
        .btn-primary:hover { background: #0056b3; }
        .btn-secondary { background: #6c757d; color: white; }
        .btn-secondary:hover { background: #545b62; }
        .btn-danger { background: #dc3545; color: white; }
        .btn-danger:hover { background: #c82333; }
        .btn-success { background: #28a745; color: white; }
        .btn-success:hover { background: #218838; }
        .btn-undefined { background: #ffc107; color: #212529; }
        .btn-undefined:hover { background: #e0a800; }
        .btn-warning { background: #fd7e14; color: white; }
        .btn-warning:hover { background: #e8590c; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 20px; }
        .image-stack, .image-container { background: white; border-radius: 12px; padding: 15px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); }
        .group-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #eee; }
        .stack-image, .single-image { max-width: 100%; height: auto; border-radius: 8px; margin: 8px 0; display: block; }
        .single-image { max-width: 200px; }
        .sensor-data { display: none; background: #f8f9fa; border-radius: 8px; padding: 10px; margin-top: 10px; border: 1px solid #dee2e6; font-size: 0.85rem; }
        .sensor-data.show { display: block; }
        .btn-info { background: #17a2b8; color: white; }
        .btn-info:hover { background: #138496; }
        .text-center { text-align: center; }

        /* Quick description styles */
        .quick-description-area { 
          background: #e8f4f8; 
          padding: 15px; 
          border-radius: 8px; 
          margin-bottom: 15px; 
          border-left: 4px solid #17a2b8; 
        }
        .quick-description-area h4 { 
          color: #0c5460; 
          margin-bottom: 8px; 
          font-size: 14px; 
        }
        .quick-description-area input { 
          width: 100%; 
          padding: 8px; 
          border: 1px solid #b8daff; 
          border-radius: 4px; 
          font-size: 14px; 
          background: white;
        }
        .quick-description-area input:focus { 
          outline: none; 
          border-color: #17a2b8; 
          box-shadow: 0 0 0 2px rgba(23, 162, 184, 0.2); 
        }

        /* Selection bar styles */
        .selection-bar {
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          background: #212529;
          color: white;
          padding: 15px 20px;
          display: none;
          align-items: center;
          justify-content: space-between;
          box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.2);
          z-index: 1000;
        }
        .selection-bar.show { display: flex; }
        .selection-info { font-size: 16px; }
        .selection-actions { display: flex; gap: 10px; }
        .item-checkbox, .group-checkbox {
          position: absolute;
          top: 10px;
          left: 10px;
          width: 20px;
          height: 20px;
          cursor: pointer;
          z-index: 10;
        }
        .image-container, .image-stack {
          position: relative;
        }
        .image-container.selected, .image-stack.selected {
          outline: 3px solid #007bff;
          background: #e3f2fd;
        }

        /* Modal styles */
        .modal {
          display: none;
          position: fixed;
          z-index: 2000;
          left: 0;
          top: 0;
          width: 100%;
          height: 100%;
          background-color: rgba(0,0,0,0.5);
        }
        .modal.show { display: flex; align-items: center; justify-content: center; }
        .modal-content {
          background: white;
          padding: 20px;
          border-radius: 12px;
          max-width: 700px;
          max-height: 80vh;
          overflow-y: auto;
          width: 90%;
        }
        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }
        .modal-close {
          font-size: 28px;
          cursor: pointer;
          color: #666;
        }
        .modal-close:hover { color: #000; }
        .cluster-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
          gap: 15px;
        }
        .cluster-option {
          cursor: pointer;
          text-align: center;
          padding: 10px;
          border: 2px solid #ddd;
          border-radius: 8px;
          transition: all 0.2s;
        }
        .cluster-option:hover {
          border-color: #007bff;
          background: #f0f8ff;
        }
        .cluster-option.new-cluster {
          border: 2px dashed #28a745;
          background: #f0fff0;
        }
        .cluster-option.new-cluster:hover {
          border-color: #28a745;
          background: #e8f5e8;
        }
        .cluster-option img {
          width: 100%;
          height: 100px;
          object-fit: cover;
          border-radius: 4px;
          margin-bottom: 8px;
        }
        .cluster-option-name {
          font-size: 14px;
          font-weight: 500;
        }

        /* New cluster input */
        .new-cluster-input {
          display: none;
          margin-top: 15px;
          padding: 15px;
          background: #f8f9fa;
          border-radius: 8px;
          border: 1px solid #dee2e6;
        }
        .new-cluster-input.show { display: block; }
        .new-cluster-input input {
          width: 100%;
          padding: 10px;
          border: 1px solid #ced4da;
          border-radius: 6px;
          margin-bottom: 10px;
          font-family: inherit;
        }
        .new-cluster-input .btn-group {
          display: flex;
          gap: 10px;
        }
        
        ${CONFIG.ANNOTATIONS_ENABLED ? `
        .form-area { background: white; padding: 25px; border-radius: 12px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); margin-bottom: 30px; }
        .form-section { margin-bottom: 20px; }
        .form-section h3 { color: #495057; margin-bottom: 15px; font-size: 1.1rem; }
        .action-item { background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; padding: 15px; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
        .text-field { background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; padding: 15px; margin-bottom: 15px; }
        .text-field label { display: block; margin-bottom: 8px; font-weight: 500; color: #495057; }
        .text-field input, .text-field textarea { width: 100%; padding: 10px; border: 1px solid #ced4da; border-radius: 6px; font-family: inherit; font-size: 14px; }
        .text-field textarea { resize: vertical; min-height: 80px; }
        select { padding: 8px; border: 1px solid #ced4da; border-radius: 4px; margin: 4px; font-family: inherit; }
        .alert { padding: 12px 16px; border-radius: 6px; margin: 10px 0; }
        .alert-success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
        .alert-error { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
        ` : ''}
      </style>
    </head>
    <body>
      <div class="header">
        <h1>📝 Review: ${folder}</h1>
        <div class="counter">📦 ${done} processati su ${total} cluster totali (${remaining} restanti)</div>
      </div>
      
      <div class="controls">
        <button class="btn btn-primary" onclick="saveAndNext()">💾 Salva e Avanti</button>
        <button class="btn btn-warning" onclick="skipCluster()">⏭️ Salta Cluster</button>
        <button class="btn btn-danger" onclick="moveCluster()">🗑️ Sposta cluster in undefined</button>
      </div>
      
      ${CONFIG.ANNOTATIONS_ENABLED ? `
      <div class="form-area">
        <div class="form-section">
          <h3>📝 Descrizioni Avanzate</h3>
          <div class="text-field">
            <label for="simple-description">🔍 Descrizione semplice:</label>
            <input type="text" id="simple-description" placeholder="Inserisci una descrizione breve del cluster...">
          </div>
          <div class="text-field">
            <label for="output-vocale">🎤 Output vocale:</label>
            <textarea id="output-vocale" placeholder="Inserisci il testo da convertire in audio..."></textarea>
          </div>
        </div>

        <div class="form-section">
          <h3>⚡ Azioni</h3>
          <div id="actions-container"></div>
          <button type="button" class="btn btn-primary" onclick="addAction()">
            + Aggiungi Azione
          </button>
        </div>
        
        <div id="alert-container"></div>
      </div>
      ` : `
      <!-- Quick description when annotations are disabled -->
      <div class="controls">
        <div class="quick-description-area">
          <h4>📝 Descrizione Rapida (opzionale)</h4>
          <input type="text" id="quick-description" placeholder="Aggiungi una breve descrizione per questo cluster..." maxlength="100">
        </div>
      </div>
      `}
      
      <div class="grid">
        ${content}
      </div>

      <div class="controls">
        <button class="btn btn-primary" onclick="saveAndNext()">💾 Salva e Avanti</button>
        <button class="btn btn-warning" onclick="skipCluster()">⏭️ Salta Cluster</button>
        <button class="btn btn-danger" onclick="moveCluster()">🗑️ Sposta cluster in undefined</button>
      </div>

      <!-- Selection bar -->
      <div class="selection-bar" id="selection-bar">
        <div class="selection-info">
          <span id="selection-count">0</span> elementi selezionati
          <span style="margin-left: 15px; font-size: 13px; opacity: 0.8;">
            💡 Trascina per selezionare • Shift+click per intervalli
          </span>
        </div>
        <div class="selection-actions">
          <button class="btn btn-primary" onclick="selectAll()">Seleziona Tutto</button>
          <button class="btn btn-secondary" onclick="deselectAll()">Deseleziona</button>
          <button class="btn btn-undefined" onclick="moveSelectedToUndefined()">Move to Undefined</button>
          <button class="btn btn-success" onclick="showClusterSelectionModal()">Sposta in Cluster</button>
        </div>
      </div>

      <!-- Cluster selection modal -->
      <div id="cluster-modal" class="modal">
        <div class="modal-content">
          <div class="modal-header">
            <h2>Seleziona cluster di destinazione</h2>
            <span class="modal-close" onclick="closeModal()">&times;</span>
          </div>
          <div id="cluster-grid" class="cluster-grid">
            <!-- Populated dynamically -->
          </div>
          <div class="new-cluster-input" id="new-cluster-input">
            <h4>🆕 Crea nuovo cluster</h4>
            <input type="text" id="new-cluster-name" placeholder="Nome del nuovo cluster (es: cluster_123 o descrizione)" maxlength="50">
            <div class="btn-group">
              <button class="btn btn-success" onclick="createAndMoveToNewCluster()">✅ Crea e Sposta</button>
              <button class="btn btn-secondary" onclick="cancelNewCluster()">❌ Annulla</button>
            </div>
          </div>
        </div>
      </div>
      <script>
        ${CONFIG.ANNOTATIONS_ENABLED ? `
        const ACTIONS = ${JSON.stringify(ACTIONS)};
        const CONFIG_ACTIONS = ${JSON.stringify(CONFIG.actionParams)};
        
        function showAlert(message, type = 'success') {
          const container = document.getElementById('alert-container');
          const alertClass = type === 'success' ? 'alert-success' : 'alert-error';
          container.innerHTML = '<div class="alert ' + alertClass + '">' + message + '</div>';
          setTimeout(() => container.innerHTML = '', 5000);
        }
        
        function addAction() {
          const container = document.getElementById('actions-container');
          const idx = container.children.length;
          
          const actionDiv = document.createElement('div');
          actionDiv.className = 'action-item';
          actionDiv.setAttribute('data-idx', idx);

          const actionSelect = document.createElement('select');
          actionSelect.id = "action_" + idx;
          actionSelect.style.flex = '1';
          ACTIONS.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a;
            opt.text = a;
            actionSelect.append(opt);
          });

          const paramsContainer = document.createElement('div');
          paramsContainer.id = "params_" + idx;
          paramsContainer.style.display = 'flex';
          paramsContainer.style.gap = '8px';

          function renderParams() {
            paramsContainer.innerHTML = '';
            const selected = actionSelect.value;
            if (CONFIG_ACTIONS[selected]) {
              CONFIG_ACTIONS[selected].forEach((options, pi) => {
                const sel = document.createElement('select');
                sel.size = 1;
                options.forEach(optVal => {
                  const o = document.createElement('option');
                  o.value = optVal;
                  o.text = optVal;
                  sel.append(o);
                });
                paramsContainer.append(sel);
              });
            }
          }

          actionSelect.addEventListener('change', renderParams);
          renderParams();

          const removeBtn = document.createElement('button');
          removeBtn.className = 'btn btn-danger';
          removeBtn.textContent = '🗑️';
          removeBtn.onclick = () => actionDiv.remove();

          actionDiv.append(actionSelect, paramsContainer, removeBtn);
          container.appendChild(actionDiv);
        }

        document.addEventListener('DOMContentLoaded', () => addAction());
        ` : ''}
        
        // ADVANCED SELECTION MANAGEMENT WITH DRAG AND SHIFT
        let selectedItems = new Set();
        let isDragging = false;
        let lastSelectedItem = null;
        let isMouseDown = false;

        function toggleSelection(item, event) {
          event = event || window.event;
          const element = document.querySelector(\`[data-item="\${item}"]\`);
          const checkbox = element.querySelector('input[type="checkbox"]');
          
          // Handle Shift+click for range selection
          if (event && event.shiftKey && lastSelectedItem) {
            selectRange(lastSelectedItem, item);
            return;
          }
          
          if (selectedItems.has(item)) {
            selectedItems.delete(item);
            element.classList.remove('selected');
            if (checkbox) checkbox.checked = false;
          } else {
            selectedItems.add(item);
            element.classList.add('selected');
            if (checkbox) checkbox.checked = true;
            lastSelectedItem = item;
          }
          
          updateSelectionBar();
        }

        function selectRange(startItem, endItem) {
          const allItems = Array.from(document.querySelectorAll('[data-item]')).map(el => el.getAttribute('data-item'));
          const startIndex = allItems.indexOf(startItem);
          const endIndex = allItems.indexOf(endItem);
          
          if (startIndex === -1 || endIndex === -1) return;
          
          const minIndex = Math.min(startIndex, endIndex);
          const maxIndex = Math.max(startIndex, endIndex);
          
          for (let i = minIndex; i <= maxIndex; i++) {
            const item = allItems[i];
            const element = document.querySelector(\`[data-item="\${item}"]\`);
            const checkbox = element.querySelector('input[type="checkbox"]');
            
            if (!selectedItems.has(item)) {
              selectedItems.add(item);
              element.classList.add('selected');
              if (checkbox) checkbox.checked = true;
            }
          }
          
          updateSelectionBar();
        }

        // DRAG SELECTION HANDLERS
        function handleMouseDown(item, event) {
          event.preventDefault();
          isMouseDown = true;
          
          // If not shift, handle normal selection
          if (!event.shiftKey) {
            toggleSelection(item, event);
          }
          
          // Start drag selection
          document.addEventListener('mousemove', handleMouseMove);
          document.addEventListener('mouseup', handleMouseUp);
        }

        function handleMouseMove(event) {
          if (!isMouseDown) return;
          
          isDragging = true;
          const elementUnderMouse = document.elementFromPoint(event.clientX, event.clientY);
          const container = elementUnderMouse?.closest('[data-item]');
          
          if (container) {
            const item = container.getAttribute('data-item');
            if (item && !selectedItems.has(item)) {
              selectedItems.add(item);
              container.classList.add('selected');
              const checkbox = container.querySelector('input[type="checkbox"]');
              if (checkbox) checkbox.checked = true;
              updateSelectionBar();
            }
          }
        }

        function handleMouseUp(event) {
          isMouseDown = false;
          isDragging = false;
          
          document.removeEventListener('mousemove', handleMouseMove);
          document.removeEventListener('mouseup', handleMouseUp);
          
          // If was shift and not drag, handle range selection
          if (event.shiftKey && !isDragging) {
            const elementUnderMouse = document.elementFromPoint(event.clientX, event.clientY);
            const container = elementUnderMouse?.closest('[data-item]');
            if (container && lastSelectedItem) {
              const item = container.getAttribute('data-item');
              selectRange(lastSelectedItem, item);
            }
          }
        }

        // Prevent text selection during drag
        document.addEventListener('selectstart', function(e) {
          if (isDragging) e.preventDefault();
        });

        // Setup event listeners for selectable items
        document.addEventListener('DOMContentLoaded', function() {
          const selectableItems = document.querySelectorAll('[data-item]');
          
          selectableItems.forEach(element => {
            const item = element.getAttribute('data-item');
            
            // Remove existing onclick handlers from checkboxes
            const checkbox = element.querySelector('.item-checkbox, .group-checkbox');
            if (checkbox) {
              checkbox.removeAttribute('onchange');
              checkbox.addEventListener('change', function(e) {
                e.stopPropagation();
                toggleSelection(item, e);
              });
            }
            
            // Add mouse down event listener to the whole element
            element.addEventListener('mousedown', function(e) {
              // If click on checkbox, let the change event handle it
              if (e.target.classList.contains('item-checkbox') || e.target.classList.contains('group-checkbox')) {
                return;
              }
              handleMouseDown(item, e);
            });
            
            // Add regular click for compatibility
            element.addEventListener('click', function(e) {
              if (e.target.classList.contains('item-checkbox') || e.target.classList.contains('group-checkbox')) {
                return;
              }
              if (!isDragging) {
                toggleSelection(item, e);
              }
            });
          });
        });

        function updateSelectionBar() {
          const bar = document.getElementById('selection-bar');
          const count = document.getElementById('selection-count');
          
          if (selectedItems.size > 0) {
            bar.classList.add('show');
            count.textContent = selectedItems.size;
          } else {
            bar.classList.remove('show');
          }
        }

        function selectAll() {
          const checkboxes = document.querySelectorAll('.item-checkbox, .group-checkbox');
          checkboxes.forEach(cb => {
            const item = cb.getAttribute('data-item');
            if (!selectedItems.has(item)) {
              cb.checked = true;
              selectedItems.add(item);
              cb.closest('[data-item]').classList.add('selected');
            }
          });
          updateSelectionBar();
        }

        function deselectAll() {
          selectedItems.clear();
          document.querySelectorAll('.item-checkbox, .group-checkbox').forEach(cb => {
            cb.checked = false;
            cb.closest('[data-item]').classList.remove('selected');
          });
          updateSelectionBar();
        }

        async function moveSelectedToUndefined() {
          if (selectedItems.size === 0) {
            alert('Nessun elemento selezionato');
            return;
          }
          
          if (!confirm(\`Spostare \${selectedItems.size} elementi in undefined?\`)) return;
          
          try {
            const response = await fetch('/move-multiple-to-undefined', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                folder: '${folder}',
                items: Array.from(selectedItems)
              })
            });
            
            const result = await response.json();
            
            if (result.success) {
              alert(\`Spostati \${result.moved} elementi su \${result.total}\`);
              location.reload();
            } else {
              alert('Errore: ' + (result.error || 'Sconosciuto'));
            }
          } catch (err) {
            alert('Errore: ' + err.message);
          }
        }

        async function showClusterSelectionModal() {
          if (selectedItems.size === 0) {
            alert('Nessun elemento selezionato');
            return;
          }
          
          try {
            const response = await fetch('/api/cluster-previews-extended');
            const clusters = await response.json();
            
            const grid = document.getElementById('cluster-grid');
            grid.innerHTML = clusters
              .filter(c => c.name !== '${folder}' && c.name !== '_CREATE_NEW_')
              .map(cluster => \`
                <div class="cluster-option" onclick="moveSelectedToCluster('\${cluster.name}')">
                  <img src="\${cluster.preview}" alt="\${cluster.displayName}" />
                  <div class="cluster-option-name">\${cluster.displayName}</div>
                </div>
              \`).join('') + \`
              <div class="cluster-option new-cluster" onclick="showNewClusterInput()">
                <div style="height: 100px; display: flex; align-items: center; justify-content: center; font-size: 48px; color: #28a745;">+</div>
                <div class="cluster-option-name">🆕 Crea Nuovo Cluster</div>
              </div>
            \`;
            
            document.getElementById('cluster-modal').classList.add('show');
          } catch (err) {
            alert('Errore nel caricamento cluster: ' + err.message);
          }
        }

        function showNewClusterInput() {
          document.getElementById('new-cluster-input').classList.add('show');
          document.getElementById('new-cluster-name').focus();
        }

        function cancelNewCluster() {
          document.getElementById('new-cluster-input').classList.remove('show');
          document.getElementById('new-cluster-name').value = '';
        }

        async function createAndMoveToNewCluster() {
          const newClusterName = document.getElementById('new-cluster-name').value.trim();
          
          if (!newClusterName) {
            alert('Inserisci un nome per il nuovo cluster');
            return;
          }
          
          if (!confirm(\`Creare il nuovo cluster "\${newClusterName}" e spostare \${selectedItems.size} elementi?\`)) return;
          
          try {
            const response = await fetch('/move-to-new-cluster', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sourceFolder: '${folder}',
                newClusterName: newClusterName,
                items: Array.from(selectedItems)
              })
            });
            
            const result = await response.json();
            
            if (result.success) {
              alert(\`✅ Nuovo cluster "\${result.targetCluster}" creato!\\nSpostati \${result.moved} elementi su \${result.total}\`);
              location.reload();
            } else {
              alert('Errore: ' + (result.error || 'Sconosciuto'));
            }
          } catch (err) {
            alert('Errore: ' + err.message);
          }
        }

        function closeModal() {
          document.getElementById('cluster-modal').classList.remove('show');
          cancelNewCluster();
        }

        async function moveSelectedToCluster(targetCluster) {
          if (!confirm(\`Spostare \${selectedItems.size} elementi in \${targetCluster}?\`)) return;
          
          try {
            const response = await fetch('/move-to-cluster', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sourceFolder: '${folder}',
                targetFolder: targetCluster,
                items: Array.from(selectedItems)
              })
            });
            
            const result = await response.json();
            
            if (result.success) {
              alert(\`Spostati \${result.moved} elementi su \${result.total}\`);
              location.reload();
            } else {
              alert('Errore: ' + (result.error || 'Sconosciuto'));
            }
          } catch (err) {
            alert('Errore: ' + err.message);
          }
        }

        // OTHER FUNCTIONS (Review specific or general)
        async function saveAndNext() {
          ${CONFIG.ANNOTATIONS_ENABLED ? `
          try {
            const actions = [];
            document.querySelectorAll(".action-item").forEach(div => {
              const idx = div.getAttribute('data-idx');
              const actionName = div.querySelector("#action_" + idx).value;
              const params = Array.from(div.querySelectorAll('#params_' + idx + ' select'))
                .map(sel => sel.value);
              actions.push({ action_name: actionName, params });
            });

            const simpleDescription = document.getElementById('simple-description').value;
            const outputVocale = document.getElementById('output-vocale').value;

            const response = await fetch('/annotate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                folder: '${folder}', 
                actions,
                simple_description: simpleDescription,
                output_vocale: outputVocale
              })
            });

            if (response.ok) {
              showAlert('✅ Annotazioni salvate con successo!');
              
              await fetch('/describe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folder: '${folder}', description: 'annotated' })
              });
              
              setTimeout(() => location.reload(), 800);
            } else throw new Error('Server error');
          } catch (err) {
            showAlert('❌ Errore: ' + err.message, 'error');
          }
          ` : `
          try {
            const quickDescription = document.getElementById('quick-description').value.trim();
            
            if (quickDescription) {
              await fetch('/save-quick-description', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folder: '${folder}', description: quickDescription })
              });
            }
            
            await fetch('/describe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ folder: '${folder}', description: 'reviewed' })
            });
            
            location.reload();
          } catch (err) {
            alert('❌ Errore: ' + err.message);
          }
          `}
        }
        
        async function skipCluster() {
          try {
            ${!CONFIG.ANNOTATIONS_ENABLED ? `
            const quickDescription = document.getElementById('quick-description').value.trim();
            if (quickDescription) {
              await fetch('/save-quick-description', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folder: '${folder}', description: quickDescription })
              });
            }
            ` : ''}
            
            await fetch('/skip-cluster', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ folder: '${folder}' })
            });
            location.reload();
          } catch (err) {
            alert('❌ Errore: ' + err.message);
          }
        }
        
        async function moveCluster() {
          if (!confirm('Spostare tutto il cluster in undefined?')) return;
          
          try {
            await fetch('/move-cluster', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ folder: '${folder}' })
            });
            location.reload();
          } catch (err) {
            alert('❌ Errore: ' + err.message);
          }
        }
        
        async function moveToUndefined(folder, item) {
          const itemType = ${CONFIG.GROUP_MODE} ? 'gruppo' : 'immagine';
          if (!confirm(\`Spostare \${itemType} \${item} in undefined?\`)) return;
          
          try {
            await fetch('/move-to-undefined', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ folder, item })
            });
            location.reload();
          } catch (err) {
            alert('❌ Errore: ' + err.message);
          }
        }

        async function saveAnnotations() {
          try {
            const actions = [];
            document.querySelectorAll(".action-item").forEach(div => {
              const idx = div.getAttribute('data-idx');
              const actionName = div.querySelector("#action_" + idx).value;
              const params = Array.from(div.querySelectorAll('#params_' + idx + ' select'))
                .map(sel => sel.value);
              actions.push({ action_name: actionName, params });
            });

            const simpleDescription = document.getElementById('simple-description').value;
            const outputVocale = document.getElementById('output-vocale').value;

            const response = await fetch('/annotate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                folder: '${folder}', 
                actions,
                simple_description: simpleDescription,
                output_vocale: outputVocale
              })
            });

            if (response.ok) {
              showAlert('✅ Annotazioni salvate con successo!');
              setTimeout(() => window.location.href = '/review', 800);
            } else throw new Error('Server error');
          } catch (err) {
            showAlert('❌ Errore: ' + err.message, 'error');
          }
        }

        async function moveWholeCluster() {
          if (!confirm('Spostare tutto il cluster in undefined?')) return;
          
          try {
            const response = await fetch('/move-cluster', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ folder: '${folder}' })
            });
            
            if (response.ok) {
              alert('Cluster spostato!');
              window.location.href = '/';
            } else {
              throw new Error('Errore del server');
            }
          } catch (err) {
            alert('❌ Errore: ' + err.message);
          }
        }

        // Close modal when clicking outside
        window.onclick = function(event) {
          const modal = document.getElementById('cluster-modal');
          if (event.target == modal) {
            closeModal();
          }
        }
      </script>
      
    </body>
    </html>
  `;
  
  res.send(html);
});

// API estesa per ottenere preview dei cluster con opzione "nuovo"
app.get('/api/cluster-previews-extended', (req, res) => {
  try {
    const previews = getClusterPreviewsExtended();
    res.json(previews);
  } catch (error) {
    console.error('Errore in cluster-previews-extended:', error);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// Endpoint per spostare elementi in un nuovo cluster
app.post('/move-to-new-cluster', (req, res) => {
  try {
    const { sourceFolder, newClusterName, items } = req.body;
    
    if (!sourceFolder || !newClusterName || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ 
        error: 'Parametri non validi',
        required: ['sourceFolder', 'newClusterName', 'items (array)']
      });
    }
    
    console.log(`🆕 Creazione nuovo cluster: ${newClusterName}`);
    console.log(`📂 Da: ${sourceFolder}, Elementi: ${items.length}`);
    
    const result = moveToClusterExtended(sourceFolder, newClusterName, items, true);
    
    if (result.success) {
      console.log(`✅ Nuovo cluster creato e ${result.moved} elementi spostati`);
      res.json(result);
    } else {
      console.error(`❌ Errore creazione nuovo cluster: ${result.error}`);
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('Errore in /move-to-new-cluster:', error);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// Endpoint per creare un cluster vuoto
app.post('/create-empty-cluster', (req, res) => {
  try {
    const { clusterName } = req.body;
    
    if (!clusterName) {
      return res.status(400).json({ 
        error: 'Nome cluster richiesto',
        required: ['clusterName']
      });
    }
    
    const result = createNewCluster(clusterName);
    
    if (result.success) {
      res.json({
        success: true,
        message: `Cluster "${result.clusterName}" creato con successo`,
        clusterName: result.clusterName,
        path: result.path
      });
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Errore in /create-empty-cluster:', error);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// Endpoint per ottenere informazioni sui cluster
app.get('/api/cluster-info/:name', (req, res) => {
  try {
    const clusterName = req.params.name;
    const stats = getClusterStats(clusterName);
    
    if (stats) {
      res.json(stats);
    } else {
      res.status(404).json({ error: 'Cluster non trovato' });
    }
  } catch (error) {
    console.error('Errore in /api/cluster-info:', error);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// Endpoint per ottenere il prossimo numero di cluster disponibile
app.get('/api/next-cluster-number', (req, res) => {
  try {
    const nextNumber = getNextClusterNumber();
    res.json({ 
      nextNumber,
      suggestedName: `cluster_${nextNumber}`
    });
  } catch (error) {
    console.error('Errore in /api/next-cluster-number:', error);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

function getNextClusterNumber() {
  try {
    const clusters = getAllClusters();
    let maxNumber = 0;
    
    clusters.forEach(cluster => {
      const match = cluster.match(/^cluster_(\d+)$/);
      if (match) {
        const num = parseInt(match[1]);
        if (num > maxNumber) {
          maxNumber = num;
        }
      }
    });
    
    return maxNumber + 1;
  } catch (error) {
    console.error('Errore nel calcolare prossimo numero cluster:', error);
    return 1;
  }
}

function createNewCluster(clusterName) {
  try {
    // Sanitizza il nome del cluster
    const sanitizedName = clusterName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const finalName = sanitizedName.startsWith('cluster_') ? sanitizedName : `cluster_${sanitizedName}`;
    
    const clusterPath = path.join(PATHS.base, finalName);
    
    if (fs.existsSync(clusterPath)) {
      return { success: false, error: `Cluster "${finalName}" esiste già` };
    }
    
    fse.ensureDirSync(clusterPath);
    console.log(`✅ Nuovo cluster creato: ${finalName}`);
    
    return { success: true, clusterName: finalName, path: clusterPath };
  } catch (error) {
    console.error('Errore nella creazione nuovo cluster:', error);
    return { success: false, error: error.message };
  }
}

function moveToClusterExtended(sourceFolder, targetFolder, items, createIfNotExists = false) {
  const movements = {};
  let successCount = 0;
  let newClusterCreated = false;
  
  try {
    const targetClusterPath = path.join(PATHS.base, targetFolder);
    
    // Se il cluster target non esiste e createIfNotExists è true, crealo
    if (!fs.existsSync(targetClusterPath)) {
      if (createIfNotExists) {
        const creationResult = createNewCluster(targetFolder);
        if (!creationResult.success) {
          return { success: false, error: creationResult.error };
        }
        newClusterCreated = true;
        console.log(`🆕 Nuovo cluster creato durante spostamento: ${targetFolder}`);
      } else {
        return { success: false, error: `Cluster destinazione "${targetFolder}" non trovato` };
      }
    } else {
      fse.ensureDirSync(targetClusterPath);
    }
    
    for (const item of items) {
      try {
        const sourcePath = path.join(PATHS.base, sourceFolder, item);
        const targetPath = path.join(targetClusterPath, item);
        
        if (fs.existsSync(sourcePath)) {
          fse.moveSync(sourcePath, targetPath, { overwrite: true });
          movements[`${CONFIG.BASE_FOLDER}/${sourceFolder}/${item}`] = `${CONFIG.BASE_FOLDER}/${targetFolder}/${item}`;
          successCount++;
        }
      } catch (error) {
        console.error(`Error moving ${item}:`, error);
      }
    }
    
    if (Object.keys(movements).length > 0) {
      saveMovementLog(movements);
    }
    
    return { 
      success: true, 
      moved: successCount, 
      total: items.length,
      newClusterCreated,
      targetCluster: targetFolder
    };
  } catch (error) {
    console.error('Errore in moveToClusterExtended:', error);
    return { success: false, error: error.message };
  }
}

function getClusterPreviewsExtended() {
  const clusters = getAllClusters();
  const previews = [];
  
  // Aggiungi opzione per creare nuovo cluster
  previews.push({
    name: '_CREATE_NEW_',
    preview: '/indefinite/new_cluster_icon.png', // Puoi aggiungere un'icona predefinita
    displayName: '🆕 Crea Nuovo Cluster',
    isNew: true
  });
  
  for (const cluster of clusters) {
    try {
      const clusterPath = path.join(PATHS.base, cluster);
      let previewImage = null;
      
      if (CONFIG.GROUP_MODE) {
        const groups = fs.readdirSync(clusterPath, { withFileTypes: true })
          .filter(dirent => dirent.isDirectory())
          .map(dirent => dirent.name);
        
        for (const group of groups) {
          const groupPath = path.join(clusterPath, group);
          const images = fs.readdirSync(groupPath).filter(isImageFile);
          if (images.length > 0) {
            previewImage = `/clusters/${cluster}/${group}/${images[0]}`;
            break;
          }
        }
      } else {
        const images = fs.readdirSync(clusterPath).filter(isImageFile);
        if (images.length > 0) {
          previewImage = `/clusters/${cluster}/${images[0]}`;
        }
      }
      
      previews.push({
        name: cluster,
        preview: previewImage || '/indefinite/no_preview.png',
        displayName: cluster,
        isNew: false
      });
    } catch (error) {
      console.error(`Error getting preview for ${cluster}:`, error);
    }
  }
  
  return previews;
}


function generateGroupContentWithSelection(folder) {
  const clusterPath = path.join(PATHS.base, folder);
  let items = "";

  try {
    const groups = fs.readdirSync(clusterPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    for (const group of groups) {
      const groupPath = path.join(clusterPath, group);
      let images = [];
      
      try {
        images = fs.readdirSync(groupPath).filter(isImageFile);
      } catch (err) {
        console.error(`Error reading images for group ${group}:`, err);
        continue;
      }

      if (images.length === 0) continue;

      const stackHtml = images.map(img => {
        let sensorInfo = '';
        
        if (PATHS.csv && csvData.length > 0) {
          const imgName = path.parse(img).name;
          const csvTimestamp = convertFilenameToCSVTimestamp(imgName);
          const sensors = findClosestCSVRow(csvTimestamp);
          
          if (sensors) {
            sensorInfo = `
              <div class="sensor-popup">
                <h4>Sensor Data</h4>
                <p><strong>Timestamp:</strong> ${sensors.timestamp}</p>
                <p><strong>Lamp:</strong> ${sensors['light.lamp'] || 'N/A'}</p>
                <p><strong>Bed:</strong> ${sensors['light.bed'] || 'N/A'}</p>
                <p><strong>Desk:</strong> ${sensors['light.desk'] || 'N/A'}</p>
                <p><strong>Monitor:</strong> ${sensors['switch.monitor'] || 'N/A'}</p>
                <p><strong>Brightness:</strong> ${sensors['sensor.room_brightness'] || 'N/A'}</p>
              </div>
            `;
          } else {
            sensorInfo = '<div class="sensor-warning">Sensor data not available</div>';
          }
        }

        return `
          <div class="image-container">
            <img src="/clusters/${folder}/${group}/${img}" alt="${img}" class="stack-image" />
            ${sensorInfo ? `
              <button class="btn btn-info" onclick="this.nextElementSibling.classList.toggle('show')">
                ℹ️ Info
              </button>
              <div class="sensor-data">${sensorInfo}</div>
            ` : ''}
          </div>
        `;
      }).join('');

      items += `
        <div class="image-stack" data-item="${group}">
          <div class="group-header">
            <div style="display: flex; align-items: center; gap: 10px;">
              <input type="checkbox" class="group-checkbox" data-item="${group}" onchange="toggleSelection('${group}')">
              <h3>Group: ${group}</h3>
            </div>
            <button class="btn btn-undefined" onclick="moveToUndefined('${folder}', '${group}')">
              ⏳ Move to Undefined
            </button>
          </div>
          ${stackHtml}
        </div>
      `;
    }
  } catch (error) {
    console.error(`Error generating content for ${folder}:`, error);
  }

  return items;
}

function generateSingleContentWithSelection(folder) {
  const clusterPath = path.join(PATHS.base, folder);
  let items = "";

  try {
    const images = fs.readdirSync(clusterPath).filter(isImageFile);
    
    items = images.map(img => {
      let sensorInfo = '';
      
      if (PATHS.csv && csvData.length > 0) {
        const imgName = path.parse(img).name;
        const csvTimestamp = convertFilenameToCSVTimestamp(imgName);
        const sensors = findClosestCSVRow(csvTimestamp);
        
        if (sensors) {
          sensorInfo = `
            <div class="sensor-popup">
              <h4>Sensor Data</h4>
              <p><strong>Timestamp:</strong> ${sensors.timestamp}</p>
              <p><strong>Lamp:</strong> ${sensors['light.lamp'] || 'N/A'}</p>
              <p><strong>Bed:</strong> ${sensors['light.bed'] || 'N/A'}</p>
              <p><strong>Desk:</strong> ${sensors['light.desk'] || 'N/A'}</p>
              <p><strong>Monitor:</strong> ${sensors['switch.monitor'] || 'N/A'}</p>
              <p><strong>Brightness:</strong> ${sensors['sensor.room_brightness'] || 'N/A'}</p>
            </div>
          `;
        } else {
          sensorInfo = '<div class="sensor-warning">Sensor data not available</div>';
        }
      }

      return `
        <div class="image-container" data-item="${img}">
          <input type="checkbox" class="item-checkbox" data-item="${img}" onchange="toggleSelection('${img}')">
          <img src="/clusters/${folder}/${img}" alt="${img}" class="single-image" />
          <button class="btn btn-undefined" onclick="moveToUndefined('${folder}', '${img}')">
            Move to Undefined
          </button>
          ${sensorInfo ? `
            <button class="btn btn-info" onclick="this.nextElementSibling.classList.toggle('show')">
              ℹ️ Info
            </button>
            <div class="sensor-data">${sensorInfo}</div>
          ` : ''}
        </div>
      `;
    }).join('');
  } catch (error) {
    console.error(`Error generating single content for ${folder}:`, error);
  }

  return items;
}


// ========================================
// FUNZIONI PER DESCRIZIONE RAPIDA E SKIP
// ========================================

// Gestisce il file per le descrizioni rapide (separate da quelle complete)
const QUICK_DESCRIPTIONS_FILE = path.join(__dirname, "quick_descriptions.csv");

function saveQuickDescription(folder, description) {
  try {
    let rows = [];
    
    // Carica descrizioni esistenti
    if (fs.existsSync(QUICK_DESCRIPTIONS_FILE)) {
      const content = fs.readFileSync(QUICK_DESCRIPTIONS_FILE, "utf8").trim();
      if (content) {
        const lines = content.split("\n").slice(1); // Salta header
        rows = lines
          .map(line => {
            // Parse CSV manuale più robusto
            const commaIndex = line.indexOf(',');
            if (commaIndex === -1) return null;
            
            const f = line.substring(0, commaIndex);
            let d = line.substring(commaIndex + 1);
            
            // Rimuovi le virgolette di inizio e fine se presenti
            if (d.startsWith('"') && d.endsWith('"')) {
              d = d.slice(1, -1);
            }
            // Unescape le virgolette doppie
            d = d.replace(/""/g, '"');
            
            return { folder: f, description: d };
          })
          .filter(r => r && r.folder !== folder); // Rimuovi descrizione esistente per questo folder
      }
    }
    
    // Aggiungi nuova descrizione se non vuota
    if (description && description.trim()) {
      rows.push({ folder, description: description.trim() });
    }
    
    // Salva il file
    const header = "folder,description\n";
    const data = rows.map(r => {
      // Escape solo le virgolette che sono già presenti nel testo
      const escapedDescription = r.description.replace(/"/g, '""');
      return `${r.folder},"${escapedDescription}"`;
    }).join("\n");
    fs.writeFileSync(QUICK_DESCRIPTIONS_FILE, header + data, "utf8");
    
    console.log(`📝 Descrizione rapida salvata per ${folder}: "${description}"`);
    return true;
  } catch (error) {
    console.error('Errore nel salvare descrizione rapida:', error);
    return false;
  }
}

function getQuickDescription(folder) {
  try {
    if (!fs.existsSync(QUICK_DESCRIPTIONS_FILE)) return null;
    
    const content = fs.readFileSync(QUICK_DESCRIPTIONS_FILE, "utf8").trim();
    if (!content) return null;
    
    const lines = content.split("\n").slice(1); // Salta header
    for (const line of lines) {
      // Parse CSV manuale più semplice
      const commaIndex = line.indexOf(',');
      if (commaIndex === -1) continue;
      
      const f = line.substring(0, commaIndex);
      let d = line.substring(commaIndex + 1);
      
      if (f === folder) {
        // Rimuovi le virgolette di inizio e fine se presenti
        if (d.startsWith('"') && d.endsWith('"')) {
          d = d.slice(1, -1);
        }
        // Unescape le virgolette doppie
        d = d.replace(/""/g, '"');
        return d || null;
      }
    }
    return null;
  } catch (error) {
    console.error('Errore nel leggere descrizione rapida:', error);
    return null;
  }
}

// Gestisce il file per i cluster saltati
const SKIPPED_CLUSTERS_FILE = path.join(__dirname, "skipped_clusters.json");

function loadSkippedClusters() {
  try {
    if (!fs.existsSync(SKIPPED_CLUSTERS_FILE)) return [];
    const data = fs.readFileSync(SKIPPED_CLUSTERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Errore nel caricamento cluster saltati:', error);
    return [];
  }
}

function saveSkippedClusters(skippedList) {
  try {
    fs.writeFileSync(SKIPPED_CLUSTERS_FILE, JSON.stringify(skippedList, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Errore nel salvare cluster saltati:', error);
    return false;
  }
}

function addSkippedCluster(folder) {
  try {
    let skipped = loadSkippedClusters();
    if (!skipped.includes(folder)) {
      skipped.push(folder);
      saveSkippedClusters(skipped);
      console.log(`⏭️ Cluster ${folder} aggiunto ai saltati`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Errore nell\'aggiungere cluster saltato:', error);
    return false;
  }
}

function removeSkippedCluster(folder) {
  try {
    let skipped = loadSkippedClusters();
    const index = skipped.indexOf(folder);
    if (index > -1) {
      skipped.splice(index, 1);
      saveSkippedClusters(skipped);
      console.log(`✅ Cluster ${folder} rimosso dai saltati`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Errore nel rimuovere cluster saltato:', error);
    return false;
  }
}

// ========================================
// ENDPOINT API PER DESCRIZIONE RAPIDA E SKIP
// ========================================

app.post('/save-quick-description', (req, res) => {
  try {
    const { folder, description } = req.body;
    
    if (!folder) {
      return res.status(400).json({ error: 'Parametro folder mancante' });
    }
    
    const result = saveQuickDescription(folder, description);
    
    if (result) {
      res.json({ 
        success: true, 
        message: `Descrizione rapida salvata per ${folder}`,
        description: description || null
      });
    } else {
      res.status(500).json({ error: 'Errore nel salvare la descrizione rapida' });
    }
  } catch (error) {
    console.error('Errore in save-quick-description:', error);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

app.post('/skip-cluster', (req, res) => {
  try {
    const { folder } = req.body;
    
    if (!folder) {
      return res.status(400).json({ error: 'Parametro folder mancante' });
    }
    
    const result = addSkippedCluster(folder);
    
    if (result) {
      res.json({ 
        success: true, 
        message: `Cluster ${folder} saltato con successo`
      });
    } else {
      res.json({ 
        success: true, 
        message: `Cluster ${folder} era già stato saltato`
      });
    }
  } catch (error) {
    console.error('Errore in skip-cluster:', error);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// ========================================
// FUNZIONE PER UNIRE CLUSTER (se non già presente)
// ========================================

function mergeMultipleClusters(clusterNames, targetCluster = null) {
  const movements = {};
  let totalMoved = 0;
  let totalCount = 0;
  const errors = [];
  
  try {
    // Se non specificato, usa il primo cluster come target
    if (!targetCluster) {
      targetCluster = clusterNames[0];
    }
    
    // Verifica che il target esista
    const targetPath = path.join(PATHS.base, targetCluster);
    if (!fs.existsSync(targetPath)) {
      return { success: false, error: `Cluster destinazione ${targetCluster} non trovato` };
    }
    
    // Filtra i cluster da unire (escludi il target)
    const sourceClusters = clusterNames.filter(name => name !== targetCluster);
    
    if (sourceClusters.length === 0) {
      return { success: false, error: 'Nessun cluster da unire' };
    }
    
    console.log(`🔀 Unendo ${sourceClusters.length} cluster in ${targetCluster}`);
    
    // Unisci ogni cluster sorgente nel target
    for (const sourceCluster of sourceClusters) {
      try {
        const sourcePath = path.join(PATHS.base, sourceCluster);
        
        if (!fs.existsSync(sourcePath)) {
          errors.push(`Cluster ${sourceCluster} non trovato`);
          continue;
        }
        
        if (CONFIG.GROUP_MODE) {
          // In modalità gruppi
          const groups = fs.readdirSync(sourcePath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
          
          for (const group of groups) {
            try {
              const sourceGroupPath = path.join(sourcePath, group);
              const targetGroupPath = path.join(targetPath, group);
              
              // Se il gruppo esiste già nel target, sposta i file singolarmente
              if (fs.existsSync(targetGroupPath)) {
                const files = fs.readdirSync(sourceGroupPath).filter(isImageFile);
                
                for (const file of files) {
                  try {
                    const sourceFilePath = path.join(sourceGroupPath, file);
                    const targetFilePath = path.join(targetGroupPath, file);
                    
                    let finalTargetPath = targetFilePath;
                    if (fs.existsSync(targetFilePath)) {
                      const ext = path.extname(file);
                      const base = path.basename(file, ext);
                      const timestamp = Date.now();
                      finalTargetPath = path.join(targetGroupPath, `${base}_merged_${timestamp}${ext}`);
                    }
                    
                    fse.moveSync(sourceFilePath, finalTargetPath, { overwrite: false });
                    movements[`${CONFIG.BASE_FOLDER}/${sourceCluster}/${group}/${file}`] = 
                      `${CONFIG.BASE_FOLDER}/${targetCluster}/${group}/${path.basename(finalTargetPath)}`;
                    totalMoved++;
                    totalCount++;
                  } catch (error) {
                    console.error(`Errore spostamento file ${file}:`, error);
                    totalCount++;
                  }
                }
                
                try {
                  fs.rmdirSync(sourceGroupPath);
                } catch (e) {
                  console.warn(`Impossibile rimuovere cartella gruppo ${group}:`, e.message);
                }
              } else {
                // Sposta l'intera cartella gruppo
                fse.moveSync(sourceGroupPath, targetGroupPath, { overwrite: false });
                
                const files = fs.readdirSync(targetGroupPath).filter(isImageFile);
                for (const file of files) {
                  movements[`${CONFIG.BASE_FOLDER}/${sourceCluster}/${group}/${file}`] = 
                    `${CONFIG.BASE_FOLDER}/${targetCluster}/${group}/${file}`;
                  totalMoved++;
                  totalCount++;
                }
              }
            } catch (error) {
              console.error(`Errore spostamento gruppo ${group}:`, error);
            }
          }
        } else {
          // In modalità singola
          const files = fs.readdirSync(sourcePath).filter(isImageFile);
          
          for (const file of files) {
            try {
              const sourceFilePath = path.join(sourcePath, file);
              const targetFilePath = path.join(targetPath, file);
              
              let finalTargetPath = targetFilePath;
              if (fs.existsSync(targetFilePath)) {
                const ext = path.extname(file);
                const base = path.basename(file, ext);
                const timestamp = Date.now();
                finalTargetPath = path.join(targetPath, `${base}_merged_${timestamp}${ext}`);
              }
              
              fse.moveSync(sourceFilePath, finalTargetPath, { overwrite: false });
              movements[`${CONFIG.BASE_FOLDER}/${sourceCluster}/${file}`] = 
                `${CONFIG.BASE_FOLDER}/${targetCluster}/${path.basename(finalTargetPath)}`;
              totalMoved++;
              totalCount++;
            } catch (error) {
              console.error(`Errore spostamento file ${file}:`, error);
              totalCount++;
            }
          }
        }
        
        // Rimuovi il cluster sorgente vuoto
        try {
          fs.rmdirSync(sourcePath);
          console.log(`✅ Cluster ${sourceCluster} rimosso dopo merge`);
        } catch (error) {
          console.warn(`⚠️ Impossibile rimuovere cartella cluster ${sourceCluster}:`, error.message);
        }
        
      } catch (error) {
        errors.push(`Errore con cluster ${sourceCluster}: ${error.message}`);
        console.error(`Errore nel processare cluster ${sourceCluster}:`, error);
      }
    }
    
    // Salva i movimenti nel log
    if (Object.keys(movements).length > 0) {
      saveMovementLog(movements);
    }
    
    return { 
      success: true, 
      moved: totalMoved, 
      total: totalCount,
      targetCluster,
      mergedClusters: sourceClusters,
      errors: errors.length > 0 ? errors : null,
      message: `Uniti ${totalMoved} elementi da ${sourceClusters.length} cluster in ${targetCluster}`
    };
    
  } catch (error) {
    console.error('Errore in mergeMultipleClusters:', error);
    return { success: false, error: error.message };
  }
}

function mergeClusterInto(sourceCluster, targetCluster) {
  const movements = {};
  let successCount = 0;
  let totalCount = 0;
  
  try {
    const sourcePath = path.join(PATHS.base, sourceCluster);
    const targetPath = path.join(PATHS.base, targetCluster);
    
    // Verifica che entrambi i cluster esistano
    if (!fs.existsSync(sourcePath)) {
      return { success: false, error: `Cluster sorgente ${sourceCluster} non trovato` };
    }
    
    if (!fs.existsSync(targetPath)) {
      return { success: false, error: `Cluster destinazione ${targetCluster} non trovato` };
    }
    
    // Assicurati che non siano lo stesso cluster
    if (sourceCluster === targetCluster) {
      return { success: false, error: 'Cluster sorgente e destinazione devono essere diversi' };
    }
    
    if (CONFIG.GROUP_MODE) {
      // In modalità gruppi, sposta tutte le sottocartelle (gruppi)
      const groups = fs.readdirSync(sourcePath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);
      
      for (const group of groups) {
        try {
          const sourceGroupPath = path.join(sourcePath, group);
          const targetGroupPath = path.join(targetPath, group);
          
          // Se il gruppo esiste già nel target, sposta i file singolarmente
          if (fs.existsSync(targetGroupPath)) {
            const files = fs.readdirSync(sourceGroupPath).filter(isImageFile);
            
            for (const file of files) {
              try {
                const sourceFilePath = path.join(sourceGroupPath, file);
                const targetFilePath = path.join(targetGroupPath, file);
                
                // Se il file esiste già, rinominalo con un timestamp
                let finalTargetPath = targetFilePath;
                if (fs.existsSync(targetFilePath)) {
                  const ext = path.extname(file);
                  const base = path.basename(file, ext);
                  const timestamp = Date.now();
                  finalTargetPath = path.join(targetGroupPath, `${base}_merged_${timestamp}${ext}`);
                }
                
                fse.moveSync(sourceFilePath, finalTargetPath, { overwrite: false });
                movements[`${CONFIG.BASE_FOLDER}/${sourceCluster}/${group}/${file}`] = 
                  `${CONFIG.BASE_FOLDER}/${targetCluster}/${group}/${path.basename(finalTargetPath)}`;
                successCount++;
                totalCount++;
              } catch (error) {
                console.error(`Errore spostamento file ${file}:`, error);
                totalCount++;
              }
            }
            
            // Rimuovi la cartella gruppo vuota
            try {
              fs.rmdirSync(sourceGroupPath);
            } catch (e) {
              console.warn(`Impossibile rimuovere cartella gruppo ${group}:`, e.message);
            }
          } else {
            // Se il gruppo non esiste, sposta l'intera cartella
            fse.moveSync(sourceGroupPath, targetGroupPath, { overwrite: false });
            
            // Registra tutti i file spostati
            const files = fs.readdirSync(targetGroupPath).filter(isImageFile);
            for (const file of files) {
              movements[`${CONFIG.BASE_FOLDER}/${sourceCluster}/${group}/${file}`] = 
                `${CONFIG.BASE_FOLDER}/${targetCluster}/${group}/${file}`;
              successCount++;
              totalCount++;
            }
          }
        } catch (error) {
          console.error(`Errore spostamento gruppo ${group}:`, error);
        }
      }
    } else {
      // In modalità singola, sposta tutti i file
      const files = fs.readdirSync(sourcePath).filter(isImageFile);
      
      for (const file of files) {
        try {
          const sourceFilePath = path.join(sourcePath, file);
          const targetFilePath = path.join(targetPath, file);
          
          // Se il file esiste già, rinominalo con un timestamp
          let finalTargetPath = targetFilePath;
          if (fs.existsSync(targetFilePath)) {
            const ext = path.extname(file);
            const base = path.basename(file, ext);
            const timestamp = Date.now();
            finalTargetPath = path.join(targetPath, `${base}_merged_${timestamp}${ext}`);
          }
          
          fse.moveSync(sourceFilePath, finalTargetPath, { overwrite: false });
          movements[`${CONFIG.BASE_FOLDER}/${sourceCluster}/${file}`] = 
            `${CONFIG.BASE_FOLDER}/${targetCluster}/${path.basename(finalTargetPath)}`;
          successCount++;
          totalCount++;
        } catch (error) {
          console.error(`Errore spostamento file ${file}:`, error);
          totalCount++;
        }
      }
    }
    
    // Se tutto è andato bene, rimuovi la cartella cluster vuota
    try {
      fs.rmdirSync(sourcePath);
      console.log(`✅ Cluster ${sourceCluster} rimosso dopo merge`);
    } catch (error) {
      console.warn(`⚠️ Impossibile rimuovere cartella cluster ${sourceCluster}:`, error.message);
    }
    
    // Salva i movimenti nel log
    if (Object.keys(movements).length > 0) {
      saveMovementLog(movements);
    }
    
    return { 
      success: true, 
      moved: successCount, 
      total: totalCount,
      sourceCluster,
      targetCluster,
      message: `Uniti ${successCount} elementi da ${sourceCluster} a ${targetCluster}`
    };
    
  } catch (error) {
    console.error('Errore in mergeClusterInto:', error);
    return { success: false, error: error.message };
  }
}

function getClusterStats(clusterName) {
  try {
    const clusterPath = path.join(PATHS.base, clusterName);
    
    if (!fs.existsSync(clusterPath)) {
      return null;
    }
    
    let itemCount = 0;
    let groupCount = 0;
    let previewImage = null;
    
    if (CONFIG.GROUP_MODE) {
      const groups = fs.readdirSync(clusterPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory());
      
      groupCount = groups.length;
      
      for (const group of groups) {
        const groupPath = path.join(clusterPath, group.name);
        const images = fs.readdirSync(groupPath).filter(isImageFile);
        itemCount += images.length;
        
        if (!previewImage && images.length > 0) {
          previewImage = `/clusters/${clusterName}/${group.name}/${images[0]}`;
        }
      }
    } else {
      const images = fs.readdirSync(clusterPath).filter(isImageFile);
      itemCount = images.length;
      
      if (images.length > 0) {
        previewImage = `/clusters/${clusterName}/${images[0]}`;
      }
    }
    
    return {
      name: clusterName,
      itemCount,
      groupCount,
      previewImage,
      mode: CONFIG.GROUP_MODE ? 'groups' : 'single'
    };
  } catch (error) {
    console.error(`Errore in getClusterStats per ${clusterName}:`, error);
    return null;
  }
}

// ========================================
// ROUTE PER L'INTERFACCIA DI MERGE
// ========================================
// ========================================
// ROUTE PER L'INTERFACCIA DI MERGE
// ========================================

app.get('/merge', (req, res) => {
  const clusters = getAllClusters();
  const clusterStats = clusters.map(c => getClusterStats(c)).filter(s => s !== null);
  
  const html = `
    <!DOCTYPE html>
    <html lang="it">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>🔀 Unisci Cluster - Cluster Manager</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f5f5f5; padding: 20px; line-height: 1.6; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); margin-bottom: 20px; }
        .back-link { color: #007bff; text-decoration: none; font-weight: 500; margin-bottom: 10px; display: inline-block; }
        .back-link:hover { text-decoration: underline; }
        h1 { color: #333; font-size: 2rem; }
        
        .instructions { background: #e3f2fd; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        .instructions h3 { color: #1976d2; margin-bottom: 10px; }
        .instructions p { margin: 5px 0; color: #424242; }
        
        .cluster-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 20px; background: white; padding: 25px; border-radius: 12px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); }
        
        .cluster-card { 
          background: #f8f9fa; 
          border: 2px solid #dee2e6; 
          border-radius: 8px; 
          padding: 15px; 
          cursor: pointer; 
          transition: all 0.2s; 
          position: relative;
        }
        .cluster-card:hover { 
          border-color: #007bff; 
          transform: translateY(-2px);
          box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
        }
        .cluster-card.selected { 
          border-color: #28a745; 
          background: #d4edda;
        }
        .cluster-card.selected .cluster-checkbox { background: #28a745; }
        .cluster-card.selected .cluster-checkbox::after { opacity: 1; }
        
        .cluster-checkbox {
          position: absolute;
          top: 10px;
          right: 10px;
          width: 24px;
          height: 24px;
          background: white;
          border: 2px solid #dee2e6;
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .cluster-checkbox::after {
          content: '✓';
          color: white;
          font-size: 16px;
          font-weight: bold;
          opacity: 0;
          transition: opacity 0.2s;
        }
        
        .cluster-preview { width: 100%; height: 140px; object-fit: cover; border-radius: 4px; margin-bottom: 12px; background: #e0e0e0; }
        .cluster-name { font-weight: 600; font-size: 15px; margin-bottom: 8px; }
        .cluster-stats { font-size: 13px; color: #666; }
        .cluster-order { 
          position: absolute; 
          top: 10px; 
          left: 10px; 
          background: #007bff; 
          color: white; 
          width: 28px; 
          height: 28px; 
          border-radius: 50%; 
          display: none; 
          align-items: center; 
          justify-content: center; 
          font-weight: bold;
          font-size: 14px;
        }
        .cluster-card.selected .cluster-order { display: flex; }
        
        .controls { background: white; padding: 25px; border-radius: 12px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); margin-top: 20px; text-align: center; }
        
        .selection-info { 
          background: #f8f9fa; 
          padding: 20px; 
          border-radius: 8px; 
          margin-bottom: 20px;
          display: none;
        }
        .selection-info.show { display: block; }
        .selection-info h3 { color: #495057; margin-bottom: 10px; }
        .selection-list { margin: 10px 0; }
        .selection-list-item { 
          display: inline-block; 
          background: #e3f2fd; 
          padding: 4px 12px; 
          border-radius: 20px; 
          margin: 4px;
          font-size: 14px;
        }
        .selection-list-item.target { background: #d4edda; font-weight: 600; }
        
        .btn { padding: 12px 24px; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; font-size: 16px; transition: background-color 0.2s; margin: 5px; }
        .btn-primary { background: #007bff; color: white; }
        .btn-primary:hover { background: #0056b3; }
        .btn-primary:disabled { background: #6c757d; cursor: not-allowed; }
        .btn-secondary { background: #6c757d; color: white; }
        .btn-secondary:hover { background: #545b62; }
        .btn-success { background: #28a745; color: white; }
        .btn-success:hover { background: #218838; }
        
        .alert { padding: 15px 20px; border-radius: 8px; margin: 20px 0; }
        .alert-warning { background: #fff3cd; border: 1px solid #ffeeba; color: #856404; }
        .alert-success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
        .alert-error { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
        
        .no-clusters { text-align: center; padding: 40px; background: white; border-radius: 12px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); }
        
        /* Loader */
        .loader { display: none; text-align: center; margin: 20px 0; }
        .loader.show { display: block; }
        .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #007bff; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <a href="/" class="back-link">← Torna alla Home</a>
          <h1>🔀 Unisci Cluster</h1>
        </div>
        
        ${clusters.length < 2 ? `
          <div class="no-clusters">
            <h2>⚠️ Cluster insufficienti</h2>
            <p>Sono necessari almeno 2 cluster per poter eseguire un'unione.</p>
            <p>Cluster disponibili: ${clusters.length}</p>
          </div>
        ` : `
          <div class="instructions">
            <h3>📋 Come funziona</h3>
            <p>1. Seleziona i cluster che vuoi unire cliccandoci sopra</p>
            <p>2. Il primo cluster selezionato (contrassegnato con "1") sarà la destinazione</p>
            <p>3. Tutti gli altri cluster selezionati verranno uniti nel primo e poi eliminati</p>
            <p>4. I file con nomi duplicati verranno rinominati automaticamente</p>
          </div>
          
          <div class="cluster-grid">
            ${clusterStats.map(stats => `
              <div class="cluster-card" data-cluster="${stats.name}" onclick="toggleClusterSelection('${stats.name}')">
                <div class="cluster-checkbox"></div>
                <div class="cluster-order"></div>
                ${stats.previewImage ? `<img src="${stats.previewImage}" alt="${stats.name}" class="cluster-preview">` : '<div class="cluster-preview"></div>'}
                <div class="cluster-name">${stats.name}</div>
                <div class="cluster-stats">
                  ${stats.itemCount} ${stats.itemCount === 1 ? 'elemento' : 'elementi'}
                  ${CONFIG.GROUP_MODE ? `<br>${stats.groupCount} ${stats.groupCount === 1 ? 'gruppo' : 'gruppi'}` : ''}
                </div>
              </div>
            `).join('')}
          </div>
          
          <div class="controls">
            <div id="alert-container"></div>
            
            <div class="selection-info" id="selection-info">
              <h3>📋 Riepilogo Operazione</h3>
              <div id="selection-details"></div>
            </div>
            
            <div class="loader" id="loader">
              <div class="spinner"></div>
              <p style="margin-top: 10px;">Unione in corso...</p>
            </div>
            
            <button class="btn btn-secondary" onclick="selectAll()">
              ☑️ Seleziona Tutto
            </button>
            <button class="btn btn-secondary" onclick="deselectAll()">
              ⬜ Deseleziona Tutto
            </button>
            <button class="btn btn-primary" id="merge-btn" onclick="performMerge()" disabled>
              🔀 Unisci Cluster Selezionati
            </button>
          </div>
        `}
      </div>
      
      <script>
        const clusterStats = ${JSON.stringify(clusterStats)};
        let selectedClusters = [];
        
        function showAlert(message, type = 'success') {
          const container = document.getElementById('alert-container');
          const alertClass = 'alert-' + type;
          container.innerHTML = '<div class="alert ' + alertClass + '">' + message + '</div>';
          if (type !== 'error') {
            setTimeout(() => container.innerHTML = '', 5000);
          }
        }
        
        function toggleClusterSelection(clusterName) {
          const card = document.querySelector('[data-cluster="' + clusterName + '"]');
          const index = selectedClusters.indexOf(clusterName);
          
          if (index === -1) {
            selectedClusters.push(clusterName);
            card.classList.add('selected');
          } else {
            selectedClusters.splice(index, 1);
            card.classList.remove('selected');
          }
          
          updateSelectionDisplay();
        }
        
        function selectAll() {
          selectedClusters = clusterStats.map(c => c.name);
          document.querySelectorAll('.cluster-card').forEach(card => {
            card.classList.add('selected');
          });
          updateSelectionDisplay();
        }
        
        function deselectAll() {
          selectedClusters = [];
          document.querySelectorAll('.cluster-card').forEach(card => {
            card.classList.remove('selected');
          });
          updateSelectionDisplay();
        }
        
        function updateSelectionDisplay() {
          // Aggiorna i numeri d'ordine
          selectedClusters.forEach((clusterName, index) => {
            const card = document.querySelector('[data-cluster="' + clusterName + '"]');
            const orderEl = card.querySelector('.cluster-order');
            orderEl.textContent = index + 1;
          });
          
          // Aggiorna il pulsante e le info
          const btn = document.getElementById('merge-btn');
          const info = document.getElementById('selection-info');
          const details = document.getElementById('selection-details');
          
          if (selectedClusters.length >= 2) {
            btn.disabled = false;
            info.classList.add('show');
            
            const targetCluster = selectedClusters[0];
            const sourceClusters = selectedClusters.slice(1);
            
            let totalItems = 0;
            sourceClusters.forEach(name => {
              const stats = clusterStats.find(c => c.name === name);
              totalItems += stats.itemCount;
            });
            
            const targetStats = clusterStats.find(c => c.name === targetCluster);
            
            details.innerHTML = \`
              <p><strong>Cluster destinazione:</strong></p>
              <div class="selection-list">
                <span class="selection-list-item target">📥 \${targetCluster} (\${targetStats.itemCount} elementi)</span>
              </div>
              <p><strong>Cluster da unire:</strong></p>
              <div class="selection-list">
                \${sourceClusters.map(name => {
                  const stats = clusterStats.find(c => c.name === name);
                  return '<span class="selection-list-item">📤 ' + name + ' (' + stats.itemCount + ' elementi)</span>';
                }).join('')}
              </div>
              <p style="margin-top: 15px;"><strong>Totale elementi da spostare:</strong> \${totalItems}</p>
              <p><strong>Elementi finali in \${targetCluster}:</strong> \${targetStats.itemCount + totalItems}</p>
            \`;
          } else {
            btn.disabled = true;
            info.classList.remove('show');
          }
        }
        
        async function performMerge() {
          if (selectedClusters.length < 2) {
            showAlert('⚠️ Seleziona almeno 2 cluster da unire!', 'warning');
            return;
          }
          
          const targetCluster = selectedClusters[0];
          const sourceClusters = selectedClusters.slice(1);
          
          const confirmMsg = 'Vuoi unire ' + sourceClusters.length + ' cluster in "' + targetCluster + '"?\\n\\n' +
                           'Cluster da unire: ' + sourceClusters.join(', ') + '\\n\\n' +
                           '⚠️ I cluster uniti verranno eliminati!';
          
          if (!confirm(confirmMsg)) return;
          
          const loader = document.getElementById('loader');
          const btn = document.getElementById('merge-btn');
          
          try {
            loader.classList.add('show');
            btn.disabled = true;
            
            const response = await fetch('/merge-multiple-clusters', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                clusterNames: selectedClusters,
                targetCluster: targetCluster
              })
            });
            
            const result = await response.json();
            
            if (result.success) {
              showAlert('✅ ' + result.message, 'success');
              if (result.errors && result.errors.length > 0) {
                showAlert('⚠️ Alcuni errori: ' + result.errors.join(', '), 'warning');
              }
              setTimeout(() => {
                window.location.href = '/cluster/' + result.targetCluster;
              }, 2000);
            } else {
              showAlert('❌ Errore: ' + result.error, 'error');
              btn.disabled = false;
            }
          } catch (error) {
            showAlert('❌ Errore: ' + error.message, 'error');
            btn.disabled = false;
          } finally {
            loader.classList.remove('show');
          }
        }
      </script>
    </body>
    </html>
  `;
  
  res.send(html);
});

// ========================================
// ENDPOINT API PER UNIRE CLUSTER
// ========================================

app.post('/merge-multiple-clusters', (req, res) => {
  try {
    const { clusterNames, targetCluster } = req.body;
    
    if (!clusterNames || !Array.isArray(clusterNames) || clusterNames.length < 2) {
      return res.status(400).json({ 
        error: 'Servono almeno 2 cluster per l\'unione',
        required: ['clusterNames (array con almeno 2 elementi)']
      });
    }
    
    console.log(`🔄 Richiesta merge multiplo: ${clusterNames.join(', ')}`);
    console.log(`📥 Target cluster: ${targetCluster || clusterNames[0]}`);
    
    const result = mergeMultipleClusters(clusterNames, targetCluster);
    
    if (result.success) {
      console.log(`✅ Merge completato: ${result.moved}/${result.total} elementi spostati`);
      res.json(result);
    } else {
      console.error(`❌ Errore merge: ${result.error}`);
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('Errore in /merge-multiple-clusters:', error);
    res.status(500).json({ 
      error: 'Errore interno del server',
      details: error.message 
    });
  }
});

app.post('/merge-clusters', (req, res) => {
  try {
    const { sourceCluster, targetCluster } = req.body;
    
    if (!sourceCluster || !targetCluster) {
      return res.status(400).json({ 
        error: 'Parametri mancanti',
        required: ['sourceCluster', 'targetCluster']
      });
    }
    
    console.log(`🔄 Richiesta merge: ${sourceCluster} -> ${targetCluster}`);
    
    const result = mergeClusterInto(sourceCluster, targetCluster);
    
    if (result.success) {
      console.log(`✅ Merge completato: ${result.moved}/${result.total} elementi spostati`);
      res.json(result);
    } else {
      console.error(`❌ Errore merge: ${result.error}`);
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('Errore in /merge-clusters:', error);
    res.status(500).json({ 
      error: 'Errore interno del server',
      details: error.message 
    });
  }
});

// ========================================
// API ENDPOINTS
// ========================================

app.post("/describe", (req, res) => {
  try {
    const { folder, description } = req.body;
    if (!folder || !description) {
      return res.status(400).json({ error: 'Parametri mancanti' });
    }
    
    saveCsv(folder, description);
    res.json({ success: true });
  } catch (error) {
    console.error('Errore nel salvare descrizione:', error);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

app.post('/move-to-undefined', (req, res) => {
  try {
    const { folder, item } = req.body;
    
    if (!folder || !item) {
      return res.status(400).json({ error: 'Parametri mancanti' });
    }
    
    const result = moveToUndefined(folder, item);
    
    if (result) {
      res.json({ success: true, message: `${item} spostato in undefined` });
    } else {
      res.status(500).json({ error: 'Errore nello spostamento' });
    }
  } catch (error) {
    console.error('Errore nello spostamento:', error);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

app.post('/move-cluster', (req, res) => {
  try {
    const { folder } = req.body;
    
    if (!folder) {
      return res.status(400).json({ error: 'Parametro folder mancante' });
    }
    
    const result = moveClusterToUndefined(folder);
    
    if (result) {
      res.json({ success: true, message: `Cluster ${folder} spostato in undefined` });
    } else {
      res.status(500).json({ error: 'Errore nello spostamento del cluster' });
    }
  } catch (error) {
    console.error('Errore nello spostamento cluster:', error);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

app.post('/annotate', (req, res) => {
  if (!CONFIG.ANNOTATIONS_ENABLED) {
    return res.status(400).json({ error: 'Annotazioni disabilitate' });
  }
  
  try {
    const { folder, actions, simple_description, output_vocale } = req.body;
    if (!folder || !actions) {
      return res.status(400).json({
        error: 'Parametri mancanti',
        required: ['folder', 'actions']
      });
    }

    let annotations = loadAnnotations() || [];
    annotations = annotations.filter(ann => ann.cluster !== folder);

    const clusterPath = path.join(PATHS.base, folder);
    if (!fs.existsSync(clusterPath)) {
      return res.status(404).json({ error: 'Cluster non trovato' });
    }

    if (CONFIG.GROUP_MODE) {
      const groups = fs.readdirSync(clusterPath, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      groups.forEach(group => {
        const groupPath = path.join(clusterPath, group);
        const images = fs.readdirSync(groupPath).filter(isImageFile);
        const sorted = images.sort();

        const inputs = sorted.map(img => {
          const imgPath = path.join(CONFIG.BASE_FOLDER, folder, group, img);
          let sensors = {}, timestamp = null;
          
          if (PATHS.csv && csvData.length > 0) {
            try {
              const csvTs = convertFilenameToCSVTimestamp(path.parse(img).name);
              const row = findClosestCSVRow(csvTs);
              if (row) {
                sensors = { ...row };
                delete sensors.timestamp;
                timestamp = csvTs;
              }
            } catch (e) {
              console.error(`Errore sensori per ${img}:`, e);
            }
          }
          
          return { img_path: imgPath, sensors, timestamp };
        });

        annotations.push({
          cluster: folder,
          group: group,
          inputs,
          outputs: {
            actions,
            simple_description: simple_description || '',
            output_vocale: output_vocale || ''
          }
        });
      });
    } else {
      const images = fs.readdirSync(clusterPath).filter(isImageFile);
      const sorted = images.sort();

      const inputs = sorted.map(img => {
        const imgPath = path.join(CONFIG.BASE_FOLDER, folder, img);
        let sensors = {}, timestamp = null;
        
        if (PATHS.csv && csvData.length > 0) {
          try {
            const csvTs = convertFilenameToCSVTimestamp(path.parse(img).name);
            const row = findClosestCSVRow(csvTs);
            if (row) {
              sensors = { ...row };
              delete sensors.timestamp;
              timestamp = csvTs;
            }
          } catch (e) {
            console.error(`Errore sensori per ${img}:`, e);
          }
        }
        
        return { img_path: imgPath, sensors, timestamp };
      });

      annotations.push({
        cluster: folder,
        inputs,
        outputs: {
          actions,
          simple_description: simple_description || '',
          output_vocale: output_vocale || ''
        }
      });
    }

    saveAnnotations(annotations);

    res.json({
      success: true,
      message: `Annotazioni salvate per cluster "${folder}"`,
      total_annotations: annotations.length
    });

  } catch (err) {
    console.error('Errore salvataggio annotazioni:', err);
    res.status(500).json({
      error: 'Errore interno del server',
      details: err.message
    });
  }
});

// Gestione annotazioni (se abilitate)
if (CONFIG.ANNOTATIONS_ENABLED) {
  app.get('/annotations', (req, res) => {
    const annotations = loadAnnotations();
    
    const html = `
      <!DOCTYPE html>
      <html lang="it">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Gestione Annotazioni</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f8f9fa; padding: 20px; }
          .header { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); margin-bottom: 20px; }
          .back-link { color: #007bff; text-decoration: none; font-weight: 500; }
          .back-link:hover { text-decoration: underline; }
          h1 { color: #333; margin: 10px 0; font-size: 2rem; }
          .stats { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); margin-bottom: 20px; }
          .annotation-item { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); margin-bottom: 15px; }
          .annotation-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
          .btn { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; transition: background-color 0.2s; }
          .btn-danger { background: #dc3545; color: white; }
          .btn-danger:hover { background: #c82333; }
          .btn-primary { background: #007bff; color: white; }
          .btn-primary:hover { background: #0056b3; }
          pre { background: #f8f9fa; padding: 10px; border-radius: 6px; overflow-x: auto; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="header">
          <a href="/" class="back-link">← Torna alla home</a>
          <h1>📋 Gestione Annotazioni</h1>
        </div>
        
        <div class="stats">
          <h3>📊 Statistiche</h3>
          <p><strong>Totale annotazioni:</strong> ${annotations.length}</p>
          <p><strong>Cluster annotati:</strong> ${new Set(annotations.map(a => a.cluster)).size}</p>
          <button class="btn btn-primary" onclick="downloadAnnotations()">💾 Scarica JSON</button>
          <button class="btn btn-danger" onclick="clearAllAnnotations()">🗑️ Cancella Tutto</button>
        </div>
        
        <div id="annotations-list">
          ${annotations.map((ann, index) => `
            <div class="annotation-item">
              <div class="annotation-header">
                <h4>Cluster: ${ann.cluster}${ann.group ? ` - Gruppo: ${ann.group}` : ''}</h4>
                <button class="btn btn-danger" onclick="deleteAnnotation(${index})">🗑️ Elimina</button>
              </div>
              <p><strong>Immagini:</strong> ${ann.inputs?.length || 0}</p>
              <p><strong>Azioni:</strong> ${ann.outputs?.actions?.length || 0}</p>
              <p><strong>Descrizione:</strong> ${ann.outputs?.simple_description || 'N/A'}</p>
              <details>
                <summary>Dettagli completi</summary>
                <pre>${JSON.stringify(ann, null, 2)}</pre>
              </details>
            </div>
          `).join('')}
        </div>
        
        <script>
          async function deleteAnnotation(index) {
            if (!confirm('Eliminare questa annotazione?')) return;
            
            try {
              const response = await fetch('/delete-annotation', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ index })
              });
              
              if (response.ok) {
                location.reload();
              } else {
                alert('Errore nell\\'eliminazione');
              }
            } catch (err) {
              alert('Errore: ' + err.message);
            }
          }
          
          async function clearAllAnnotations() {
            if (!confirm('Eliminare TUTTE le annotazioni? Questa azione non può essere annullata!')) return;
            
            try {
              const response = await fetch('/clear-annotations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
              });
              
              if (response.ok) {
                location.reload();
              } else {
                alert('Errore nella cancellazione');
              }
            } catch (err) {
              alert('Errore: ' + err.message);
            }
          }
          
          function downloadAnnotations() {
            const annotations = ${JSON.stringify(annotations)};
            const blob = new Blob([JSON.stringify(annotations, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'annotations.json';
            a.click();
            URL.revokeObjectURL(url);
          }
        </script>
      </body>
      </html>
    `;
    
    res.send(html);
  });

  app.post('/delete-annotation', (req, res) => {
    try {
      const { index } = req.body;
      let annotations = loadAnnotations();
      
      if (index >= 0 && index < annotations.length) {
        annotations.splice(index, 1);
        saveAnnotations(annotations);
        res.json({ success: true });
      } else {
        res.status(400).json({ error: 'Indice non valido' });
      }
    } catch (error) {
      console.error('Errore nell\'eliminazione annotazione:', error);
      res.status(500).json({ error: 'Errore interno del server' });
    }
  });

  app.post('/clear-annotations', (req, res) => {
    try {
      saveAnnotations([]);
      res.json({ success: true });
    } catch (error) {
      console.error('Errore nella cancellazione annotazioni:', error);
      res.status(500).json({ error: 'Errore interno del server' });
    }
  });
}

// ========================================
// NUOVE API ROUTES PER SELEZIONE MULTIPLA
// ========================================

app.post('/move-multiple-to-undefined', (req, res) => {
  try {
    const { folder, items } = req.body;
    
    if (!folder || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Parametri non validi' });
    }
    
    const result = moveMultipleToUndefined(folder, items);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('Errore in move-multiple-to-undefined:', error);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

app.post('/move-to-cluster', (req, res) => {
  try {
    const { sourceFolder, targetFolder, items } = req.body;
    
    if (!sourceFolder || !targetFolder || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Parametri non validi' });
    }
    
    const result = moveToCluster(sourceFolder, targetFolder, items);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('Errore in move-to-cluster:', error);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

app.get('/api/cluster-previews', (req, res) => {
  try {
    const previews = getClusterPreviews();
    res.json(previews);
  } catch (error) {
    console.error('Errore in cluster-previews:', error);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

// ========================================
// ERROR HANDLING
// ========================================

app.use((req, res) => {
  res.status(404).send(`
    <html>
      <body style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h1>❌ Pagina non trovata</h1>
        <p>La risorsa richiesta non è disponibile.</p>
        <a href="/" style="color: #007bff;">← Torna alla home</a>
      </body>
    </html>
  `);
});

app.use((error, req, res, next) => {
  console.error('Errore server:', error);
  res.status(500).json({
    error: 'Errore interno del server',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Qualcosa è andato storto'
  });
});

// ========================================
// SERVER STARTUP
// ========================================

// Crea cartelle necessarie
if (!fs.existsSync(PATHS.undefined)) {
  fs.mkdirSync(PATHS.undefined, { recursive: true });
}
if (!fs.existsSync(PATHS.indefinite)) {
  fs.mkdirSync(PATHS.indefinite, { recursive: true });
}

loadCSVData()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`
🚀 Cluster Manager avviato con successo!
📍 URL: http://localhost:${PORT}

⚙️  CONFIGURAZIONE ATTUALE:
📁 Cartella base: ${CONFIG.BASE_FOLDER} ${fs.existsSync(PATHS.base) ? '✅' : '❌'}
📊 File CSV: ${CONFIG.CSV_FILE || 'Disabilitato'} ${CONFIG.CSV_FILE && fs.existsSync(PATHS.csv) ? '✅' : '❌'}
🔄 Modalità: ${CONFIG.GROUP_MODE ? 'Gruppi (ogni cluster diviso in gruppi)' : 'Singola (immagini singole)'}
📝 Annotazioni: ${CONFIG.ANNOTATIONS_ENABLED ? 'Abilitate' : 'Disabilitate'}

📂 Directory:
   - Cluster: ${PATHS.base}
   - Undefined: ${PATHS.undefined}
   - Indefinite: ${PATHS.indefinite}
   - Descrizioni: ${PATHS.descriptions}
   ${CONFIG.ANNOTATIONS_ENABLED ? `- Annotazioni: ${PATHS.annotations}` : ''}

📊 Dati sensori: ${csvData.length ? `${csvData.length} righe caricate` : 'Nessun dato'}

🎛️  Per modificare la configurazione, vai su: http://localhost:${PORT}/settings
      `);
    });
  })
  .catch(error => {
    console.error('Errore nel caricamento:', error);
    process.exit(1);
  });
