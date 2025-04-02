require('dotenv').config(); // Cargar variables de entorno
const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises; // Necesario para operaciones async de FS
const path = require('path');
const crypto = require('crypto'); // Necesario para SHA1

/**
 * Clase para interactuar con la API de Backblaze B2
 * Permite crear múltiples instancias con diferentes credenciales
 */
class BackblazeB2 {
  /**
   * Constructor de la clase BackblazeB2
   * @param {Object} options - Opciones de configuración
   * @param {string} options.keyId - ID de la clave de API (por defecto usa B2_KEY_ID de .env)
   * @param {string} options.applicationKey - Clave de aplicación (por defecto usa B2_APPLICATION_KEY de .env)
   * @param {string} options.authUrl - URL de autenticación
   * @param {string} options.defaultBucket - Nombre del bucket por defecto
   */
  constructor(options = {}) {
    this.config = {
      keyId: options.keyId || process.env.B2_KEY_ID,
      applicationKey: options.applicationKey || process.env.B2_APPLICATION_KEY,
      authUrl: options.authUrl || 'https://api.backblazeb2.com/b2api/v2/b2_authorize_account',
      apiUrl: '', // Se obtendrá durante la autenticación
      authorizationToken: '', // Se obtendrá durante la autenticación
      downloadUrl: '', // Se obtendrá durante la autenticación
      defaultBucket: options.defaultBucket || 'cloud-video-store'
    };
    this.uploadHistory = new Map(); // Mapa para almacenar el historial de subidas
  }

  /**
   * Método para autenticarse en Backblaze B2
   * @returns {Promise<boolean>} - true si la autenticación fue exitosa, false en caso contrario
   */
  async authorize() {
    try {
      const authString = Buffer.from(`${this.config.keyId}:${this.config.applicationKey}`).toString('base64');
      const response = await axios.get(this.config.authUrl, {
        headers: {
          'Authorization': `Basic ${authString}`
        }
      });

      const data = response.data;
      this.config.apiUrl = data.apiUrl;
      this.config.authorizationToken = data.authorizationToken;
      this.config.downloadUrl = data.downloadUrl;
      
      console.log('Autenticación exitosa');
      console.log('API URL:', this.config.apiUrl);
      console.log('Token de autorización:', this.config.authorizationToken);
      
      return true;
    } catch (error) {
      console.error('Error en autenticación:', error.response ? error.response.data : error.message);
      return false;
    }
  }

  /**
   * Método para listar únicamente las "carpetas" virtuales en un bucket
   * @param {string} bucketId - ID del bucket
   * @param {string} folderPath - Ruta de la carpeta (prefijo) a listar
   * @returns {Promise<Array>} - Array con la información de las carpetas encontradas
   */
  async listOnlyFolders(bucketId, folderPath = '') {
    try {
      const result = await this.listFolder(bucketId, folderPath);
      // listFolder devuelve { folders: [], files: [] }
      // Solo devolvemos el array de carpetas
      return result.folders || []; 
    } catch (error) {
      // El error ya se maneja y loguea dentro de listFolder
      // Devolvemos un array vacío en caso de error para mantener consistencia
      console.error(`Error al listar solo carpetas en '${folderPath}':`, error.message);
      return [];
    }
  }

  /**
   * Método para listar buckets
   * @returns {Promise<Array>} - Array de buckets disponibles
   */
  async listBuckets() {
    try {
      // Asegurar que estamos autenticados
      if (!this.config.authorizationToken) {
        const authSuccess = await this.authorize();
        if (!authSuccess) return [];
      }

      const response = await axios.post(`${this.config.apiUrl}/b2api/v2/b2_list_buckets`, {
        accountId: this.config.keyId
      }, {
        headers: {
          'Authorization': this.config.authorizationToken
        }
      });

      console.log('Buckets disponibles:');
      response.data.buckets.forEach(bucket => {
        console.log(`- ${bucket.bucketName} (${bucket.bucketId})`);
      });
      
      return response.data.buckets;
    } catch (error) {
      console.error('Error al listar buckets:', error.response ? error.response.data : error.message);
      return [];
    }
  }

  /**
   * Método para subir un archivo
   * @param {string} bucketId - ID del bucket donde se subirá el archivo
   * @param {string} fileName - Nombre del archivo en B2
   * @param {string} filePath - Ruta local del archivo a subir
   * @returns {Promise<Object|null>} - Información del archivo subido o null si hubo error
   */
  async uploadFile(bucketId, fileName, filePath) {
    try {
      // Asegurar que estamos autenticados
      if (!this.config.authorizationToken) {
        const authSuccess = await this.authorize();
        if (!authSuccess) return null;
      }

      // 1. Obtener URL de upload
      const uploadUrlResponse = await axios.post(`${this.config.apiUrl}/b2api/v2/b2_get_upload_url`, {
        bucketId: bucketId
      }, {
        headers: {
          'Authorization': this.config.authorizationToken
        }
      });

      const uploadUrl = uploadUrlResponse.data.uploadUrl;
      const uploadAuthToken = uploadUrlResponse.data.authorizationToken;

      // 2. Leer el archivo
      const fileContent = fs.readFileSync(filePath);
      const fileSize = fs.statSync(filePath).size;
      const sha1 = crypto.createHash('sha1').update(fileContent).digest('hex');

      // 3. Subir el archivo
      const uploadResponse = await axios.post(uploadUrl, fileContent, {
        headers: {
          'Authorization': uploadAuthToken,
          'X-Bz-File-Name': encodeURIComponent(fileName),
          'Content-Type': 'b2/x-auto',
          'X-Bz-Content-Sha1': sha1,
          'Content-Length': fileSize
        }
      });

      const resultData = uploadResponse.data;
      console.log(`[B2 Upload] Archivo subido exitosamente: ${resultData.fileName} (ID: ${resultData.fileId})`);

      // Registrar la subida individualmente
      this._logUpload(fileName, { // Usamos fileName como clave para subidas individuales
        success: true,
        file: resultData.fileName,
        fileId: resultData.fileId,
        size: resultData.contentLength,
        timestamp: new Date().toISOString()
      });

      return resultData;
    } catch (error) {
      const errorMessage = error.response ? error.response.data : error.message;
      console.error(`[B2 Upload] Error al subir archivo ${fileName}:`, errorMessage);
       // Registrar el fallo individualmente
      this._logUpload(fileName, {
        success: false,
        file: fileName,
        error: errorMessage,
        timestamp: new Date().toISOString()
      });
      return null;
    }
  }

  /**
   * Registra una entrada en el historial de subidas.
   * @param {string} key - Clave para agrupar las subidas (e.g., videoId o nombre de archivo).
   * @param {object} logEntry - Objeto con la información de la subida.
   * @private
   */
  _logUpload(key, logEntry) {
    if (!this.uploadHistory.has(key)) {
      this.uploadHistory.set(key, []);
    }
    this.uploadHistory.get(key).push(logEntry);
  }

  /**
   * Obtiene el historial de subidas para una clave específica.
   * @param {string} key - La clave (e.g., videoId) del historial a obtener.
   * @returns {Array|undefined} - Array de entradas de log o undefined si no existe.
   */
  getUploadHistory(key) {
    return this.uploadHistory.get(key);
  }

  /**
   * Helper function to recursively list files in a directory.
   * @param {string} dirPath - Path to the directory.
   * @returns {Promise<string[]>} - Array of full file paths.
   * @private
   */
  async _listFilesInDirRecursive(dirPath) {
    let fileList = [];
    try {
        const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                fileList = fileList.concat(await this._listFilesInDirRecursive(fullPath));
            } else if (entry.isFile()) {
                fileList.push(fullPath);
            }
        }
    } catch (error) {
        console.error(`[B2 Helper] Error listando archivos en ${dirPath}:`, error);
    }
    return fileList;
  }


  /**
   * Sube todos los archivos de un directorio local a B2, manteniendo la estructura.
   * @param {string} bucketId - ID del bucket de destino.
   * @param {string} localDirPath - Ruta del directorio local a subir.
   * @param {string} b2Prefix - Prefijo (carpeta virtual) en B2 donde se subirán los archivos.
   * @returns {Promise<object>} - Objeto con el resumen de la operación { success: boolean, successfulUploads: [], failedUploads: [] }.
   */
  async uploadDirectoryToB2(bucketId, localDirPath, b2Prefix) {
    console.log(`[B2 Dir Upload] Iniciando subida del directorio ${localDirPath} a B2 con prefijo ${b2Prefix}`);
    const allLocalFiles = await this._listFilesInDirRecursive(localDirPath);
    console.log(`[B2 Dir Upload] Archivos locales encontrados (${allLocalFiles.length}):`, allLocalFiles.map(f => path.relative(localDirPath, f)));

    const uploadPromises = allLocalFiles.map(async (localFilePath) => {
        const relativePath = path.relative(localDirPath, localFilePath);
        // Asegurar separadores / para B2 y limpiar el prefijo si es necesario
        const cleanPrefix = b2Prefix.endsWith('/') ? b2Prefix : `${b2Prefix}/`;
        const b2FileName = `${cleanPrefix}${relativePath.replace(/\\/g, '/')}`;

        try {
            const result = await this.uploadFile(bucketId, b2FileName, localFilePath); // uploadFile ya registra en el historial
            if (!result) {
                 console.warn(`[B2 Dir Upload] Falló la subida a B2 para: ${b2FileName} (desde ${localFilePath})`);
                 // Registro de fallo ya hecho dentro de uploadFile
                 return { success: false, file: b2FileName, local: localFilePath };
            }
            // Registro de éxito ya hecho dentro de uploadFile
            // Agrupamos el log bajo el prefijo b2Prefix
            const logEntry = this.uploadHistory.get(b2FileName)?.pop(); // Obtenemos el último log para este archivo
            if (logEntry) {
                this._logUpload(b2Prefix, logEntry); // Lo añadimos al grupo del directorio
                this.uploadHistory.delete(b2FileName); // Eliminamos la entrada individual
            }
            return { success: true, file: b2FileName, info: result, local: localFilePath };
        } catch (uploadError) {
            console.error(`[B2 Dir Upload] Error subiendo ${b2FileName} a B2:`, uploadError);
             // Registro de fallo ya hecho dentro de uploadFile
            const logEntry = this.uploadHistory.get(b2FileName)?.pop();
             if (logEntry) {
                this._logUpload(b2Prefix, logEntry);
                this.uploadHistory.delete(b2FileName);
            }
            return { success: false, file: b2FileName, local: localFilePath };
        }
    });

    const uploadResults = await Promise.all(uploadPromises);
    const successfulUploads = uploadResults.filter(r => r.success);
    const failedUploads = uploadResults.filter(r => !r.success);

    console.log(`[B2 Dir Upload] Subidas a B2 completadas para prefijo ${b2Prefix}. Éxitos: ${successfulUploads.length}, Fallos: ${failedUploads.length}`);

    return {
        success: failedUploads.length === 0,
        successfulUploads: successfulUploads.map(r => ({ file: r.file, info: r.info })),
        failedUploads: failedUploads.map(r => ({ file: r.file, local: r.local })),
        history: this.getUploadHistory(b2Prefix) // Devolvemos el historial agrupado
    };
  }

  /**
   * Método para descargar un archivo
   * @param {string} bucketName - Nombre del bucket
   * @param {string} fileName - Nombre del archivo en B2
   * @param {string} outputPath - Ruta local donde se guardará el archivo
   * @returns {Promise<boolean>} - true si la descarga fue exitosa, false en caso contrario
   */
  async downloadFile(bucketName, fileName, outputPath) {
    try {
      // Asegurar que estamos autenticados
      if (!this.config.authorizationToken) {
        const authSuccess = await this.authorize();
        if (!authSuccess) return null;
      }

      const response = await axios.get(`${this.config.downloadUrl}/file/${bucketName}/${fileName}`, {
        headers: {
          'Authorization': this.config.authorizationToken
        },
        responseType: 'stream'
      });

      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(true));
        writer.on('error', reject);
      });
    } catch (error) {
      console.error('Error al descargar archivo:', error.response ? error.response.data : error.message);
      return false;
    }
  }

  /**
   * Método para listar archivos en un bucket
   * @param {string} bucketId - ID del bucket
   * @param {string|null} startFileName - Nombre del archivo desde donde comenzar (para paginación)
   * @param {number} maxFileCount - Número máximo de archivos a listar
   * @returns {Promise<Object|null>} - Objeto con archivos listados o null si hubo error
   */
  async listFiles(bucketId, startFileName = null, maxFileCount = 100) {
    try {
      // Asegurar que estamos autenticados
      if (!this.config.authorizationToken) {
        const authSuccess = await this.authorize();
        if (!authSuccess) return null;
      }

      const params = { bucketId };
      if (startFileName) {
        params.startFileName = startFileName;
      }
      params.maxFileCount = maxFileCount;

      const response = await axios.post(`${this.config.apiUrl}/b2api/v2/b2_list_file_names`, params, {
        headers: {
          'Authorization': this.config.authorizationToken
        }
      });
      console.log(`Archivos listados para bucket ${bucketId}:`, response.data.files.length);
      return response.data; // Contiene { files: [], nextFileName: ... }
    } catch (error) {
      console.error('Error al listar archivos:', error.response ? error.response.data : error.message);
      return null;
    }
  }

  /**
   * Método para obtener una URL de descarga con token de autorización
   * @param {string} fileName - Nombre del archivo en B2
   * @param {string} bucketName - Nombre del bucket (opcional, usa el predeterminado si no se proporciona)
   * @returns {Promise<string>} - URL de descarga con token
   */
  async getDownloadUrlWithToken(fileName, bucketName = null) {
    try {
      // Usar el bucket predeterminado si no se proporciona uno
      const bucket = bucketName || this.config.defaultBucket;
      
      // Asegurar que estamos autenticados
      if (!this.config.authorizationToken || !this.config.downloadUrl) {
        const authSuccess = await this.authorize();
        if (!authSuccess) {
          throw new Error('No se pudo autenticar con Backblaze B2');
        }
      }

      // Codificar el nombre del archivo para usarlo en la URL
      const encodedFileName = encodeURIComponent(fileName);

      // Construir la URL de descarga con el token de autorización
      const downloadUrl = `${this.config.downloadUrl}/file/${bucket}/${encodedFileName}?Authorization=${this.config.authorizationToken}`;
      
      return downloadUrl;
    } catch (error) {
      console.error('Error al generar URL de descarga:', error.message);
      throw error;
    }
  }

  /**
   * Método para buscar archivos por prefijo en un bucket
   * @param {string} bucketId - ID del bucket
   * @param {string} prefix - Prefijo para filtrar archivos (como una carpeta virtual)
   * @param {number} maxFileCount - Número máximo de archivos a listar
   * @returns {Promise<Array>} - Array de archivos que coinciden con el prefijo
   */
  async searchFilesByPrefix(bucketId, prefix, maxFileCount = 100) {
    try {
      // Asegurar que estamos autenticados
      if (!this.config.authorizationToken) {
        const authSuccess = await this.authorize();
        if (!authSuccess) return [];
      }

      const params = { 
        bucketId,
        prefix,
        maxFileCount
      };

      const response = await axios.post(`${this.config.apiUrl}/b2api/v2/b2_list_file_names`, params, {
        headers: {
          'Authorization': this.config.authorizationToken
        }
      });

      console.log(`Archivos encontrados con prefijo '${prefix}':`, response.data.files.length);
      return response.data.files;
    } catch (error) {
      console.error(`Error al buscar archivos con prefijo '${prefix}':`, error.response ? error.response.data : error.message);
      return [];
    }
  }

  /**
   * Método para buscar archivos por nombre en un bucket
   * @param {string} bucketId - ID del bucket
   * @param {string} fileName - Nombre o parte del nombre del archivo a buscar
   * @returns {Promise<Array>} - Array de archivos que coinciden con el nombre
   */
  async searchFilesByName(bucketId, fileName) {
    try {
      // Primero obtenemos todos los archivos
      const result = await this.listFiles(bucketId);
      if (!result || !result.files) return [];
      
      // Filtramos por nombre (case insensitive)
      const searchTerm = fileName.toLowerCase();
      const matchingFiles = result.files.filter(file => 
        file.fileName.toLowerCase().includes(searchTerm)
      );
      
      console.log(`Se encontraron ${matchingFiles.length} archivos que coinciden con '${fileName}'`);
      return matchingFiles;
    } catch (error) {
      console.error(`Error al buscar archivos por nombre '${fileName}':`, error.message);
      return [];
    }
  }

  /**
   * Método para listar "carpetas" virtuales en un bucket
   * En B2 no hay carpetas reales, pero podemos simularlas con prefijos y delimitadores
   * @param {string} bucketId - ID del bucket
   * @param {string} folderPath - Ruta de la carpeta (prefijo)
   * @returns {Promise<Object>} - Objeto con carpetas y archivos
   */
  async listFolder(bucketId, folderPath = '') {
    try {
      // Asegurar que estamos autenticados
      if (!this.config.authorizationToken) {
        const authSuccess = await this.authorize();
        if (!authSuccess) return { folders: [], files: [] };
      }

      // Normalizar el path para asegurar que termina con /
      const prefix = folderPath ? (folderPath.endsWith('/') ? folderPath : `${folderPath}/`) : '';
      const delimiter = '/';

      const params = { 
        bucketId,
        prefix,
        delimiter
      };

      const response = await axios.post(`${this.config.apiUrl}/b2api/v2/b2_list_file_names`, params, {
        headers: {
          'Authorization': this.config.authorizationToken
        }
      });

      // Extraer carpetas (prefijos comunes)
      const folders = response.data.commonPrefixes || [];
      
      // Extraer archivos (solo los que están en este nivel, no en subcarpetas)
      const files = response.data.files || [];

      console.log(`Listado de carpeta '${folderPath}': ${folders.length} carpetas, ${files.length} archivos`);
      return { folders, files };
    } catch (error) {
      console.error(`Error al listar carpeta '${folderPath}':`, error.response ? error.response.data : error.message);
      return { folders: [], files: [] };
    }
  }

  /**
   * Método para listar archivos de video en un bucket
   * @param {string} bucketId - ID del bucket
   * @param {string|null} startFileName - Nombre del archivo desde donde comenzar (para paginación)
   * @param {number} maxFileCount - Número máximo de archivos a listar
   * @returns {Promise<Object|null>} - Objeto con archivos de video listados o null si hubo error
   */
  /**
   * Método para listar archivos de video en un bucket con opción de filtrar por tipo
   * @param {string} bucketId - ID del bucket
   * @param {string|null} startFileName - Nombre del archivo desde donde comenzar (para paginación)
   * @param {number} maxFileCount - Número máximo de archivos a listar
   * @param {string|null} fileType - Tipo específico de archivo a filtrar (null para todos)
   * @returns {Promise<Object|null>} - Objeto con archivos de video listados o null si hubo error
   */
  async listVideoFiles(bucketId, startFileName = null, maxFileCount = 100, fileType = null) {
    try {
      // Obtener todos los archivos
      const listResult = await this.listFiles(bucketId, startFileName, maxFileCount);
      if (!listResult || !listResult.files) return null;
      
      // Definir extensiones de archivos de video permitidas
      const videoExtensions = ['master.m3u8', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv'];
      
      // Filtrar solo archivos con extensiones de video y excluir segmentos .ts
      const videoFiles = listResult.files.filter(file => {
        const fileName = file.fileName.toLowerCase();
        
        // Si se especifica un tipo de archivo, filtrar solo por ese tipo
        if (fileType) {
          return fileName.endsWith(fileType.toLowerCase());
        }
        
        // Si no se especifica tipo, usar el filtro general
        return videoExtensions.some(ext => fileName.endsWith(ext)) || 
               (fileName.endsWith('.ts') && !fileName.includes('/segment'));
      });
      
      console.log(`Archivos de video listados para bucket ${bucketId}:`, videoFiles.length);
      
      // Devolver el mismo formato que listFiles pero con los archivos filtrados
      return {
        files: videoFiles,
        nextFileName: listResult.nextFileName
      };
    } catch (error) {
      console.error('Error al listar archivos de video:', error.response ? error.response.data : error.message);
      return null;
    }
  }
  
  /**
   * Método para listar solo archivos master.m3u8 en un bucket
   * @param {string} bucketId - ID del bucket
   * @param {string|null} startFileName - Nombre del archivo desde donde comenzar (para paginación)
   * @param {number} maxFileCount - Número máximo de archivos a listar
   * @returns {Promise<Object|null>} - Objeto con archivos master.m3u8 listados o null si hubo error
   */
  async listM3u8Files(bucketId, startFileName = null, maxFileCount = 100) {
    return this.listVideoFiles(bucketId, startFileName, maxFileCount, 'master.m3u8');
  }
  
  /**
   * Método para listar solo archivos MP4 en un bucket
   * @param {string} bucketId - ID del bucket
   * @param {string|null} startFileName - Nombre del archivo desde donde comenzar (para paginación)
   * @param {number} maxFileCount - Número máximo de archivos a listar
   * @returns {Promise<Object|null>} - Objeto con archivos MP4 listados o null si hubo error
   */
  async listMp4Files(bucketId, startFileName = null, maxFileCount = 100) {
    return this.listVideoFiles(bucketId, startFileName, maxFileCount, '.mp4');
  }

  // Getters para acceder a la configuración
  getDownloadUrl() {
    return this.config.downloadUrl;
  }

  getApiUrl() {
    return this.config.apiUrl;
  }

  getAuthToken() {
    return this.config.authorizationToken;
  }
}

// Crear una instancia por defecto para mantener compatibilidad con el código existente
const defaultInstance = new BackblazeB2();

// Exportar la clase y la instancia por defecto
module.exports = {
  // Instancia por defecto para mantener compatibilidad
  authorizeAccount: () => defaultInstance.authorize(),
  listBuckets: () => defaultInstance.listBuckets(),
  uploadFile: (bucketId, fileName, filePath) => defaultInstance.uploadFile(bucketId, fileName, filePath),
  downloadFile: (bucketName, fileName, outputPath) => defaultInstance.downloadFile(bucketName, fileName, outputPath),
  listFiles: (bucketId, startFileName, maxFileCount) => defaultInstance.listFiles(bucketId, startFileName, maxFileCount),
  getDownloadUrl: () => defaultInstance.getDownloadUrl(),
  getApiUrl: () => defaultInstance.getApiUrl(),
  getAuthToken: () => defaultInstance.getAuthToken(),
  getDownloadUrlWithToken: (fileName, bucketName) => defaultInstance.getDownloadUrlWithToken(fileName, bucketName),
  
  // Nuevos métodos de búsqueda
  searchFilesByPrefix: (bucketId, prefix, maxFileCount) => defaultInstance.searchFilesByPrefix(bucketId, prefix, maxFileCount),
  searchFilesByName: (bucketId, fileName) => defaultInstance.searchFilesByName(bucketId, fileName),
  listFolder: (bucketId, folderPath) => defaultInstance.listFolder(bucketId, folderPath),
  listOnlyFolders: (bucketId, folderPath) => defaultInstance.listOnlyFolders(bucketId, folderPath), // <-- Nuevo método añadido
  listVideoFiles: (bucketId, startFileName, maxFileCount, fileType) => defaultInstance.listVideoFiles(bucketId, startFileName, maxFileCount, fileType),
  listM3u8Files: (bucketId, startFileName, maxFileCount) => defaultInstance.listM3u8Files(bucketId, startFileName, maxFileCount),
  listMp4Files: (bucketId, startFileName, maxFileCount) => defaultInstance.listMp4Files(bucketId, startFileName, maxFileCount),

  // Nuevas funciones de subida y registro
  uploadDirectoryToB2: (bucketId, localDirPath, b2Prefix) => defaultInstance.uploadDirectoryToB2(bucketId, localDirPath, b2Prefix),
  getUploadHistory: (key) => defaultInstance.getUploadHistory(key),

  // Exportar la clase para crear nuevas instancias
  BackblazeB2
};
